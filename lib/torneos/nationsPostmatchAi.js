import { createHash, randomUUID } from 'node:crypto';
import { getAiProvider } from '../../src/ai/providers/index.js';
import { resolvePromptForSkill } from '../../src/ai/prompts/registry.js';
import { loadNationsMarkerMatchContext } from './nationsMarkerMatchContext.js';
import { computeParticipation } from './nationsParticipationMarker.js';

export const NATIONS_POSTMATCH_STATUSES = Object.freeze(['queued','generating','provider_started','ready','insufficient','uncertain','failed']);
export const NATIONS_POSTMATCH_PROMPT_ID = 'nations-postmatch';
const FINAL_STATES = new Set(['terminado','finalizado']);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const finiteMs = (v) => { const n = v instanceof Date ? v.getTime() : Date.parse(v); return Number.isFinite(n) ? n : null; };
const hash = (v) => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;

function fail(code, status = 422) { throw Object.assign(new Error(code), { code, status }); }

async function tableReady(pool) {
  try { const r = await pool.query("SELECT to_regclass('nations_postmatch_ai.jobs') AS t"); return Boolean(r.rows[0]?.t); }
  catch { return false; }
}


export async function enqueueNationsPostmatchForPartido({ pool, torneoId, partidoId } = {}) {
  if (!pool || !await tableReady(pool)) return { status: 'unavailable', reason: 'SCHEMA_NOT_READY' };
  const nTorneo=Number(torneoId), nPartido=Number(partidoId);
  if(!Number.isSafeInteger(nTorneo)||nTorneo<=0||!Number.isSafeInteger(nPartido)||nPartido<=0) return {status:'invalid'};
  const row=(await pool.query(`SELECT s.id::text AS scoreboard_id,s.partido_torneo_id,s.torneo_id,s.estado
    FROM public.scoreboard_partidos s
    WHERE s.partido_torneo_id=$1 AND s.torneo_id=$2
      AND lower(coalesce(s.estado,'')) IN ('terminado','finalizado')
      AND EXISTS(SELECT 1 FROM nations_marker_private.games_finalization_intents i WHERE i.scoreboard_id=s.id AND i.status='completed')
    ORDER BY s.updated_at DESC LIMIT 1`,[nPartido,nTorneo])).rows[0];
  if(!row) return {status:'insufficient',reason:'FINAL_NOT_COMPLETED'};
  const out=await pool.query(`INSERT INTO nations_postmatch_ai.jobs(scoreboard_id,partido_torneo_id,torneo_id)
    VALUES($1,$2,$3) ON CONFLICT(scoreboard_id) DO NOTHING RETURNING scoreboard_id`,[row.scoreboard_id,nPartido,nTorneo]);
  return {status:'queued',scoreboard_id:row.scoreboard_id,inserted:out.rowCount>0};
}

export async function enqueueCompletedNationsPostmatchJobs({ pool } = {}) {
  if (!pool || !await tableReady(pool)) return { status: 'idle', reason: 'SCHEMA_NOT_READY' };
  const out = await pool.query(`
    INSERT INTO nations_postmatch_ai.jobs (scoreboard_id, partido_torneo_id, torneo_id)
    SELECT DISTINCT i.scoreboard_id::text, s.partido_torneo_id, s.torneo_id
    FROM nations_marker_private.games_finalization_intents i
    JOIN public.scoreboard_partidos s ON s.id::text = i.scoreboard_id::text
    JOIN public.torneos t ON t.id = s.torneo_id
    WHERE i.status = 'completed'
      AND COALESCE(t.es_prueba,false) = false
      AND s.partido_torneo_id IS NOT NULL
      AND s.torneo_id IS NOT NULL
      AND lower(coalesce(s.estado,'')) IN ('terminado','finalizado')
    ON CONFLICT (scoreboard_id) DO NOTHING
    RETURNING scoreboard_id
  `);
  return { status: 'ok', inserted: out.rowCount ?? 0 };
}

function normalizePointTeam(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['a','equipo_a','equipo1','equipo 1'].includes(v)) return 'A';
  if (['b','equipo_b','equipo2','equipo 2'].includes(v)) return 'B';
  return null;
}


async function completeWithTimeout(provider, args, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await provider.completeChat({ ...args, signal: controller.signal }); }
  catch (error) { if (controller.signal.aborted) throw Object.assign(new Error('AI_TIMEOUT'), { code: 'AI_TIMEOUT', status: 504 }); throw error; }
  finally { clearTimeout(timer); }
}
async function loadFacts(pool, job) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const board = (await client.query(`SELECT id, partido_torneo_id, torneo_id, sede_id, estado, score_a, score_b, games_a, games_b, sets_a, sets_b, historial_sets, updated_at
      FROM public.scoreboard_partidos WHERE id::text=$1 AND partido_torneo_id=$2 AND torneo_id=$3`, [job.scoreboard_id, job.partido_torneo_id, job.torneo_id])).rows[0];
    if (!board || !FINAL_STATES.has(String(board.estado || '').toLowerCase())) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const completed = (await client.query(`SELECT occurred_at
      FROM nations_marker_private.games_finalization_intents
      WHERE scoreboard_id::text=$1 AND status='completed' ORDER BY occurred_at DESC NULLS LAST LIMIT 1`, [job.scoreboard_id])).rows[0];
    if (!completed || !completed.occurred_at) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const context = await loadNationsMarkerMatchContext(client, String(job.scoreboard_id));
    if (context.notNations || String(context.partidoTorneoId) !== String(job.partido_torneo_id) || String(context.torneoId) !== String(job.torneo_id)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const aggregate = (await client.query(`SELECT revision, states, tracking_status, receipts, games_ledger FROM nations_marker_private.nations_marker_match WHERE match_id=$1`, [String(job.scoreboard_id)])).rows[0];
    if (!aggregate || !['active','closed'].includes(String(aggregate.tracking_status)) || !object(aggregate.states) || !object(aggregate.receipts?.start?.lineup) || !object(aggregate.games_ledger)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    for (const [teamId, team] of Object.entries(context.teams)) {
      if (Number(aggregate.receipts.start.lineup[teamId]) !== Number(team.lineup.revision)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    }
    const points = (await client.query(`SELECT timestamp, equipo FROM public.scoreboard_historial_puntos WHERE partido_id::text=$1 ORDER BY timestamp ASC, id ASC`, [job.scoreboard_id])).rows;
    if (!points.length) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    await client.query('COMMIT');
    const finalAt = finiteMs(completed.occurred_at);
    if (finalAt == null) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    return { board, context, aggregate, points, finalAt };
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
  finally { client.release(); }
}

function applyCorrections(state) {
  const patches = new Map((state.corrections || []).map((c) => [c.targetEventId, c.patch || {}]));
  return (state.events || []).map((event) => {
    if (event.type === 'correction') return event;
    const patch = patches.get(event.eventId);
    return patch ? { ...event, ...patch } : event;
  }).filter((event) => event.type !== 'correction');
}

function derivedClosedState(state, finalAt) {
  const events = applyCorrections(state);
  const closed = events.filter((e) => e.type === 'close');
  if (state.status === 'closed' || state.status === 'corrected') {
    if (closed.length !== 1 || events[events.length - 1]?.type !== 'close') fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const at = Number(closed[0].serverAt);
    if (!Number.isFinite(at) || at > finalAt) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    // Keep the original state: computeParticipation applies corrections itself
    // and expects the original contiguous event revisions.
    return { ...state, closedAt: at };
  }
  const synthetic = { eventId: 'postmatch-derived-close', type: 'close', serverAt: finalAt, revision: state.events.length + 1 };
  return { ...state, events: [...state.events, synthetic], status: 'closed', closedAt: finalAt, revision: state.events.length + 1 };
}

function pointActive(state, ts, finalAt) {
  const startedAt = Number(state.startedAt);
  const closedAt = Number(state.closedAt ?? finalAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(closedAt) || ts < startedAt || ts > closedAt) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  const effective = applyCorrections(state).filter((e) => e.type !== 'correction');
  // A point at a swap/pause timestamp has no durable ordering; a point exactly
  // at the durable final/close timestamp is the legitimate terminal point.
  const ambiguous = effective.filter((e) => e.type !== 'close' && Number(e.serverAt) === ts);
  if (ambiguous.length) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  let active = [...state.lineup.iniciales];
  let paused = false;
  for (const event of effective) {
    const at = Number(event.serverAt);
    if (!Number.isFinite(at)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    if (ts < at) break;
    if (event.type === 'pause') paused = true;
    else if (event.type === 'resume') paused = false;
    else if (event.type === 'substitution') {
      if (paused) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
      const swaps = Array.isArray(event.swaps) && event.swaps.length ? event.swaps : [{ outId: event.outId, inId: event.inId }];
      for (const swap of swaps) {
        if (!swap || !active.includes(swap.outId) || active.includes(swap.inId) || !state.roster.includes(swap.inId)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
        active = active.map((id) => id === swap.outId ? swap.inId : id);
      }
    } else if (event.type === 'close') { paused = false; }
  }
  if (paused) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  if (active.length !== 2) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  return active;
}

export function observedFacts(facts) {
  const points = facts.points.map((p) => ({ ts: finiteMs(p.timestamp), team: normalizePointTeam(p.equipo) }));
  if (points.some((p) => p.ts == null || !p.team)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  const endMs = facts.finalAt;
  if (!Number.isFinite(endMs)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  const perTeam = {};
  const rows = new Map();
  const rowFor = (side, id, name) => {
    const key = `${side}:${id}`;
    if (!rows.has(key)) rows.set(key, { id, name, team: side, points_observed: 0, on_court_seconds: 0 });
    return rows.get(key);
  };
  for (const side of ['A','B']) {
    const teamKey = facts.context.membership[side];
    const team = facts.context.teams[teamKey];
    const state = facts.aggregate.states[teamKey];
    if (!team || !state || !Array.isArray(state.active) || state.active.length !== 2) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const names = new Map((team.players || []).map((p) => [String(p.id), p.name || 'Jugador']));
    for (const id of team.players.map((p) => String(p.id))) rowFor(side, id, names.get(id) || 'Jugador');
    const derived = derivedClosedState(state, endMs);
    const participation = computeParticipation(derived, derived.lineup, { now: endMs });
    if (participation.status !== 'confirmed' || !Array.isArray(participation.players)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    for (const player of participation.players) rowFor(side, String(player.id), names.get(String(player.id)) || 'Jugador').on_court_seconds = Math.round(Number(player.activeMs) / 1000);
    perTeam[side] = { points: 0 };
    for (const point of points) {
      if (point.team !== side) continue;
      perTeam[side].points += 1;
      const active = pointActive(derived, point.ts, endMs);
      for (const id of active) rowFor(side, String(id), names.get(String(id)) || 'Jugador').points_observed += 1;
    }
  }
  const totalPoints = perTeam.A.points + perTeam.B.points;
  if (totalPoints !== points.length) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  const substitutions_timeline = [];
  for (const side of ['A','B']) {
    const teamKey=facts.context.membership[side]; const team=facts.context.teams[teamKey]; const state=facts.aggregate.states[teamKey];
    const names=new Map((team?.players||[]).map(p=>[String(p.id),p.name]));
    const effective=applyCorrections(derivedClosedState(state,endMs));
    for (const event of effective) {
      if(event.type!=='substitution') continue;
      const swaps=Array.isArray(event.swaps)&&event.swaps.length?event.swaps:[{outId:event.outId,inId:event.inId}];
      const at=Number(event.serverAt); if(!Number.isFinite(at)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA',409);
      const before={A:0,B:0},after={A:0,B:0};
      for(const point of points){if(point.ts<at)before[point.team]+=1;if(point.ts>=at)after[point.team]+=1;}
      substitutions_timeline.push({at:new Date(at).toISOString(),elapsed_seconds:Math.max(0,Math.floor((at-Number(state.startedAt))/1000)),team:side,...(event.set!=null?{set:event.set}:{}),...(event.game!=null?{game:event.game}:{}),swaps:swaps.map(swap=>({out:{id:String(swap.outId),name:names.get(String(swap.outId))||null},in:{id:String(swap.inId),name:names.get(String(swap.inId))||null}})),points_before:before,points_after:after});
    }
  }
  substitutions_timeline.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  return { team_totals: perTeam, players: [...rows.values()], substitutions: substitutions_timeline.length, substitutions_timeline, source: 'scoreboard_historial_puntos+computeParticipation' };
}


export function anonymizeObserved(observed, facts) {
  const labels = new Map();
  const idToLabel = new Map();
  const byTeam = { A: [], B: [] };
  for (const side of ['A', 'B']) {
    let n = 0;
    for (const player of observed.players.filter((p) => p.team === side)) {
      n += 1;
      const label = `${side}${n}`;
      labels.set(label, player.name);
      idToLabel.set(`${side}:${player.id}`, label);
      byTeam[side].push({ label, team: side, points_observed: player.points_observed, on_court_seconds: player.on_court_seconds });
    }
  }
  const teamNames = {
    A: facts.board.equipo_a_nombre || 'Equipo A',
    B: facts.board.equipo_b_nombre || 'Equipo B',
  };
  labels.set('Equipo A', teamNames.A); labels.set('Equipo B', teamNames.B);
  return {
    labels,
    payload: {
      teams: { A: 'Equipo A', B: 'Equipo B' },
      team_totals: observed.team_totals,
      players: [...byTeam.A, ...byTeam.B],
      substitutions: observed.substitutions,
      substitutions_timeline: (observed.substitutions_timeline||[]).map(row=>({at:row.at,team:row.team,...(row.set!=null?{set:row.set}:{}),...(row.game!=null?{game:row.game}:{}),swaps:row.swaps.map(swap=>({out:idToLabel.get(`${row.team}:${swap.out?.id}`)||'Jugador',in:idToLabel.get(`${row.team}:${swap.in?.id}`)||'Jugador'})),points_before:row.points_before,points_after:row.points_after})),
      source: observed.source,
    },
  };
}

function localize(value, labels) {
  if (typeof value === 'string') {
    let text = value;
    for (const [label, name] of labels) text = text.replace(new RegExp(`(^|[^A-Za-z0-9])${label}(?=$|[^A-Za-z0-9])`, 'g'), (_, prefix) => prefix + name);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => localize(item, labels));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v, labels)]));
  return value;
}

function finalResult(facts) {
  const b = facts.board;
  const setsA = Number(b.sets_a), setsB = Number(b.sets_b), gamesA = Number(b.games_a), gamesB = Number(b.games_b);
  if (!Number.isFinite(setsA) || !Number.isFinite(setsB) || !Number.isFinite(gamesA) || !Number.isFinite(gamesB)) return null;
  const numeric = new Set(['a','b','set','points_a','points_b','target','win_by']);
  const types = new Set(['normal','tiebreak','super_tiebreak']);
  const historial = Array.isArray(b.historial_sets) ? b.historial_sets.map((row) => {
    if (!object(row)) return null;
    const clean = {};
    for (const key of numeric) if (typeof row[key] === 'number' && Number.isFinite(row[key])) clean[key] = row[key];
    if (types.has(row.type)) clean.type = row.type;
    return Object.keys(clean).length ? clean : null;
  }).filter(Boolean) : null;
  return { sets_a: setsA, sets_b: setsB, games_a: gamesA, games_b: gamesB, historial_sets: historial };
}



const AI_HIGHLIGHT_TYPES = new Set(['resultado','stats','contexto']);
function validAiSummary(value) {
  if (!object(value)) return null;
  const allowed = new Set(['title','summary','highlights','disclaimers']);
  if (Object.keys(value).some((k) => !allowed.has(k))) return null;
  if (typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 120) return null;
  if (typeof value.summary !== 'string' || value.summary.length < 1 || value.summary.trim().split(/\s+/).length > 60) return null;
  if (!Array.isArray(value.highlights) || value.highlights.length !== 1) return null;
  if (value.highlights.some((h) => !object(h) || Object.keys(h).some((k) => !['type','text'].includes(k)) || !AI_HIGHLIGHT_TYPES.has(h.type) || typeof h.text !== 'string' || h.text.length < 1 || h.text.length > 160)) return null;
  if (!Array.isArray(value.disclaimers) || value.disclaimers.length !== 1 || value.disclaimers.some((d) => typeof d !== 'string' || d.length < 1 || d.length > 160)) return null;
  const text = JSON.stringify(value);
  if (text.includes('@') || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return null;
  return value;
}
const SYSTEM = `Eres el redactor de Padbol Match para un partido Nations finalizado.
Recibes sólo un JSON con resultado, stats observadas por jugador y sustituciones. Es la única fuente.
Formato compacto obligatorio: summary máximo 60 palabras; exactamente 1 highlight corto; exactamente 1 disclaimer corto. No markdown, no texto extra.
Respondé ÚNICAMENTE JSON válido: {"title","summary","highlights":[{"type":"resultado|stats|contexto","text"}],"disclaimers":["..."]}.
No inventes tiros, errores, aces, lesiones, MVP, causalidad, emoción, público ni jugadas.
No afirmes que viste el partido. Usá sólo puntos observados; si un dato no está, omitilo.`;


export function buildNationsPostmatchProviderRequest(facts) {
  const observed = observedFacts(facts);
  const anon = anonymizeObserved(observed, facts);
  const user = { resultado: finalResult(facts), observed: anon.payload };
  const userMessage = JSON.stringify(user);
  const requestHash = createHash('sha256').update(JSON.stringify({system:SYSTEM,userMessage})).digest('hex');
  return {system:SYSTEM,userMessage,requestHash,labels:[...anon.labels.entries()]};
}
export async function recoverStaleNationsPostmatchJobs({ pool } = {}) {
  if (!pool || !await tableReady(pool)) return { status: 'idle', reason: 'SCHEMA_NOT_READY' };
  await pool.query(`UPDATE nations_postmatch_ai.jobs SET status='uncertain', error_code='PROVIDER_UNCERTAIN', error_message='Worker/lease lost during provider call; no automatic retry', lease_token=NULL, lease_until=NULL, updated_at=now() WHERE status='provider_started' AND (lease_until IS NULL OR lease_until < now())`);
  await pool.query(`UPDATE nations_postmatch_ai.jobs SET status='queued', lease_token=NULL, lease_until=NULL, next_attempt_at=now(), updated_at=now() WHERE status='generating' AND (lease_until IS NULL OR lease_until < now())`);
  return { status: 'ok' };
}

export async function processOneNationsPostmatchJob({ pool, provider = null, getProvider = getAiProvider, leaseSeconds = 120 } = {}) {
  if (!pool || !await tableReady(pool)) return { status: 'idle', reason: 'SCHEMA_NOT_READY' };
  const token = randomUUID();
  const claimed = await pool.query(`WITH chosen AS (
    SELECT scoreboard_id FROM nations_postmatch_ai.jobs
    WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=now())
      AND (lease_until IS NULL OR lease_until<now())
    ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE nations_postmatch_ai.jobs j SET status='generating', lease_token=$1, lease_until=now()+$2*interval '1 second', attempts=attempts+1, updated_at=now()
    FROM chosen c WHERE j.scoreboard_id=c.scoreboard_id RETURNING j.*`, [token, leaseSeconds]);
  const job = claimed.rows[0];
  if (!job) return { status: 'idle' };
  try {
    const facts = await loadFacts(pool, job);
    const observed = observedFacts(facts);
    const started = await pool.query(`UPDATE nations_postmatch_ai.jobs SET status='provider_started', provider_started_at=now(), updated_at=now()
      WHERE scoreboard_id=$1 AND status='generating' AND lease_token=$2 RETURNING scoreboard_id`, [job.scoreboard_id, token]);
    if (!started.rowCount) return { status: 'lease_lost', scoreboard_id: job.scoreboard_id };
    const aiProvider = provider ?? getProvider();
    const prompt = resolvePromptForSkill('match-summary');
    const anon = anonymizeObserved(observed, facts);
    const user = { resultado: finalResult(facts), observed: anon.payload };
    let ai = null, errorCode = null;
    try {
      const { reply } = await completeWithTimeout(aiProvider, { system: SYSTEM, userMessage: JSON.stringify(user), maxTokens: Math.min(512, prompt?.maxTokens || 512) });
      const parsed = JSON.parse(String(reply).replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      if (validAiSummary(parsed)) { const localized = validAiSummary(localize(parsed, anon.labels)); if (localized && !/\b[AB]\d+\b/.test(JSON.stringify(localized))) ai = localized; }
      else errorCode = 'AI_INVALID_JSON';
    } catch (error) { errorCode = error?.code || 'AI_PROVIDER_ERROR'; }
    if (!ai) {
      const failed = errorCode === 'AI_INVALID_JSON';
      await pool.query(`UPDATE nations_postmatch_ai.jobs SET status=$2, observed=$3::jsonb, error_code=$4, error_message='AI response rejected; no automatic retry', lease_token=NULL, lease_until=NULL, updated_at=now() WHERE scoreboard_id=$1 AND lease_token=$5 AND status='provider_started'`, [job.scoreboard_id, failed ? 'failed' : 'uncertain', JSON.stringify(observed), errorCode, token]);
      return { status: failed ? 'failed' : 'uncertain', scoreboard_id: job.scoreboard_id, reason: errorCode };
    }
    const summary = ai;
    const saved = await pool.query(`UPDATE nations_postmatch_ai.jobs SET status='ready', observed=$2::jsonb, summary=$3::jsonb, provider=$4, model=$5, error_code=NULL, error_message=NULL, lease_token=NULL, lease_until=NULL, updated_at=now() WHERE scoreboard_id=$1 AND lease_token=$6 AND status='provider_started' RETURNING scoreboard_id`, [job.scoreboard_id, JSON.stringify(observed), JSON.stringify(summary), aiProvider.name || 'anthropic', process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', token]);
    if (!saved.rowCount) return { status: 'lease_lost', scoreboard_id: job.scoreboard_id };
    return { status: 'ready', scoreboard_id: job.scoreboard_id };
  } catch (error) {
    const code = /^[A-Z0-9_]{2,64}$/.test(error?.code || '') ? error.code : 'JOB_ERROR';
    await pool.query(`UPDATE nations_postmatch_ai.jobs SET status=$2, error_code=$3, error_message='Job failed closed', lease_token=NULL, lease_until=NULL, updated_at=now() WHERE scoreboard_id=$1 AND lease_token=$4`, [job.scoreboard_id, code === 'NATIONS_POSTMATCH_INSUFFICIENT_DATA' ? 'insufficient' : 'uncertain', code, token]);
    return { status: code === 'NATIONS_POSTMATCH_INSUFFICIENT_DATA' ? 'insufficient' : 'uncertain', scoreboard_id: job.scoreboard_id, reason: code };
  }
}

export function startNationsPostmatchWorker({ pool, enabled = false, intervalMs = 15000, onResult = () => {}, processJob = processOneNationsPostmatchJob } = {}) {
  if (!enabled) return () => {};
  if (!pool || !Number.isInteger(intervalMs) || intervalMs < 1000) throw Error('INVALID_POSTMATCH_WORKER');
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return; running = true;
    try {
      await recoverStaleNationsPostmatchJobs({ pool });
      await enqueueCompletedNationsPostmatchJobs({ pool });
      const result = await processJob({ pool });
      if (result.status !== 'idle') onResult(result);
    } catch (error) { onResult({ status: 'uncertain', reason: 'WORKER_ERROR' }); }
    finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs); timer.unref?.(); void tick();
  return () => { stopped = true; clearInterval(timer); };
}
