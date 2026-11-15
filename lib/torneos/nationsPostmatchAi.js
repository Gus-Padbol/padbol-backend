import { createHash, randomUUID } from 'node:crypto';
import { getAiProvider } from '../../src/ai/providers/index.js';
import { resolvePromptForSkill } from '../../src/ai/prompts/registry.js';
import { loadNationsMarkerMatchContext } from './nationsMarkerMatchContext.js';

export const NATIONS_POSTMATCH_STATUSES = Object.freeze(['queued','generating','provider_started','ready','insufficient','uncertain','failed']);
export const NATIONS_POSTMATCH_PROMPT_ID = 'nations-postmatch';
const FINAL_STATES = new Set(['terminado','finalizado']);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const finiteMs = (v) => { const n = Date.parse(v); return Number.isFinite(n) ? n : null; };
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
    WHERE i.status = 'completed'
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

async function loadFacts(pool, job) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const board = (await client.query(`SELECT id, partido_torneo_id, torneo_id, sede_id, estado, score_a, score_b, games_a, games_b, sets_a, sets_b, historial_sets, updated_at
      FROM public.scoreboard_partidos WHERE id::text=$1 AND partido_torneo_id=$2 AND torneo_id=$3`, [job.scoreboard_id, job.partido_torneo_id, job.torneo_id])).rows[0];
    if (!board || !FINAL_STATES.has(String(board.estado || '').toLowerCase())) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const completed = (await client.query(`SELECT 1 FROM nations_marker_private.games_finalization_intents
      WHERE scoreboard_id::text=$1 AND status='completed' LIMIT 1`, [job.scoreboard_id])).rowCount;
    if (!completed) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const context = await loadNationsMarkerMatchContext(client, String(job.scoreboard_id));
    if (context.notNations || String(context.partidoTorneoId) !== String(job.partido_torneo_id) || String(context.torneoId) !== String(job.torneo_id)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const aggregate = (await client.query(`SELECT revision, states, tracking_status, games_ledger FROM nations_marker_private.nations_marker_match WHERE match_id=$1`, [String(job.scoreboard_id)])).rows[0];
    if (!aggregate || !object(aggregate.states) || !object(aggregate.games_ledger)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const points = (await client.query(`SELECT timestamp, equipo FROM public.scoreboard_historial_puntos WHERE partido_id::text=$1 ORDER BY timestamp ASC, id ASC`, [job.scoreboard_id])).rows;
    if (!points.length) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    if (Number(board.score_a) + Number(board.score_b) > points.length) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    await client.query('COMMIT');
    return { board, context, aggregate, points };
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
  finally { client.release(); }
}

function buildIntervals(state, teamKey, endMs) {
  const start = Number(state.startedAt);
  if (!Number.isFinite(start) || start < 0 || !Array.isArray(state.lineup?.iniciales) || state.lineup.iniciales.length !== 2) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  const events = Array.isArray(state.events) ? state.events.filter((e) => e && e.type === 'substitution') : [];
  const intervals = new Map();
  const add = (id, from, to) => { if (!intervals.has(id)) intervals.set(id, []); intervals.get(id).push({ from, to }); };
  let active = [...state.lineup.iniciales];
  let last = start;
  for (const event of events) {
    const at = Number(event.serverAt);
    if (!Number.isFinite(at) || at < last || !active.includes(event.outId) || active.includes(event.inId)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    for (const id of active) add(id, last, at);
    active = active.map((id) => id === event.outId ? event.inId : id);
    last = at;
  }
  const end = Math.max(Number(endMs) || last, last) + 1;
  for (const id of active) add(id, last, end);
  return { intervals, teamKey, active };
}

function observedFacts(facts) {
  const points = facts.points.map((p) => ({ ts: finiteMs(p.timestamp), team: normalizePointTeam(p.equipo) }));
  if (points.some((p) => p.ts == null || !p.team)) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  const endMs = Math.max(...points.map((p) => p.ts));
  const perTeam = {};
  const playerRows = [];
  for (const side of ['A','B']) {
    const teamKey = facts.context.membership[side];
    const team = facts.context.teams[teamKey];
    const state = facts.aggregate.states[teamKey];
    if (!team || !state || !Array.isArray(state.active) || state.active.length !== 2) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
    const built = buildIntervals(state, side, endMs);
    perTeam[side] = { points: 0 };
    const names = new Map((team.players || []).map((p) => [String(p.id), p.name]));
    for (const point of points) {
      if (point.team !== side) continue;
      perTeam[side].points += 1;
      const active = [...built.intervals.entries()].filter(([, list]) => list.some((i) => point.ts >= i.from && point.ts < i.to)).map(([id]) => id);
      if (active.length !== 2) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
      for (const id of active) {
        let row = playerRows.find((p) => p.team === side && p.name === names.get(id));
        if (!row) { row = { name: names.get(id) || 'Jugador', team: side, points_observed: 0, on_court_seconds: 0 }; playerRows.push(row); }
        row.points_observed += 1;
      }
      for (const [id, list] of built.intervals) {
        let row = playerRows.find((p) => p.team === side && p.name === names.get(id));
        if (!row) { row = { name: names.get(id) || 'Jugador', team: side, points_observed: 0, on_court_seconds: 0 }; playerRows.push(row); }
        row.on_court_seconds += Math.max(0, Math.round(list.reduce((total, i) => total + Math.max(0, Math.min(i.to, point.ts + 1) - i.from), 0) / 1000));
      }
    }
  }
  const totalPoints = perTeam.A.points + perTeam.B.points;
  if (totalPoints !== points.length) fail('NATIONS_POSTMATCH_INSUFFICIENT_DATA', 409);
  return {
    team_totals: perTeam,
    players: playerRows,
    substitutions: Object.values(facts.aggregate.states).reduce((n, s) => n + (Array.isArray(s.events) ? s.events.filter((e) => e.type === 'substitution').length : 0), 0),
    source: 'scoreboard_historial_puntos+marker_intervals',
  };
}


function anonymizeObserved(observed, facts) {
  const labels = new Map();
  const byTeam = { A: [], B: [] };
  for (const side of ['A', 'B']) {
    let n = 0;
    for (const player of observed.players.filter((p) => p.team === side)) {
      n += 1;
      const label = `${side}${n}`;
      labels.set(label, player.name);
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
      source: observed.source,
    },
  };
}

function localize(value, labels) {
  if (typeof value === 'string') {
    let text = value;
    for (const [label, name] of labels) text = text.replace(new RegExp(`(^|[^A-Za-z0-9])${label}(?=$|[^A-Za-z0-9])`, 'g'), `$1${name}`);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => localize(item, labels));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v, labels)]));
  return value;
}

function fallbackSummary(facts, observed) {
  const a = facts.board.score_a, b = facts.board.score_b;
  return {
    title: 'Resumen del partido',
    summary: `Partido finalizado con marcador ${a}-${b}. Se registraron ${observed.team_totals.A.points} puntos observados para el equipo A y ${observed.team_totals.B.points} para el equipo B.`,
    highlights: [{ type: 'resultado', text: `Resultado observado: ${a}-${b}.` }],
    disclaimers: ['Resumen basado sólo en puntos y alineaciones registrados.'],
  };
}

const SYSTEM = `Eres el redactor de Padbol Match para un partido Nations finalizado.
Recibes sólo un JSON con marcador, stats observadas por jugador y sustituciones. Es la única fuente.
Respondé ÚNICAMENTE JSON válido: {"title","summary","highlights":[{"type":"resultado|stats|contexto","text"}],"disclaimers":["..."]}.
No inventes tiros, errores, aces, lesiones, MVP, causalidad, emoción, público ni jugadas.
No afirmes que viste el partido. Usá sólo puntos observados; si un dato no está, omitilo.`;

export async function generateNationsPostmatchSummary({ pool, job, provider = null, getProvider = getAiProvider } = {}) {
  const facts = await loadFacts(pool, job);
  const observed = observedFacts(facts);
  const aiProvider = provider ?? getProvider();
  const prompt = resolvePromptForSkill('match-summary');
  const anon = anonymizeObserved(observed, facts);
  const user = {
    partido_torneo_id: job.partido_torneo_id,
    torneo_id: job.torneo_id,
    marcador: { a: Number(facts.board.score_a), b: Number(facts.board.score_b), sets_a: Number(facts.board.sets_a), sets_b: Number(facts.board.sets_b) },
    observed: anon.payload,
  };
  let ai = null;
  try {
    const { reply } = await aiProvider.completeChat({ system: SYSTEM, userMessage: JSON.stringify(user), maxTokens: Math.min(512, prompt?.maxTokens || 512) });
    const parsed = JSON.parse(String(reply).replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    if (parsed && typeof parsed.title === 'string' && typeof parsed.summary === 'string' && Array.isArray(parsed.highlights) && Array.isArray(parsed.disclaimers)) { const localized = localize(parsed, anon.labels); if (!/\b[AB][1-4]\b/.test(JSON.stringify(localized))) ai = localized; }
  } catch { ai = null; }
  const summary = ai || fallbackSummary(facts, observed);
  return { facts, observed, summary, payload_hash: hash(user), provider: aiProvider.name || 'anthropic', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' };
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
    const user = { partido_torneo_id: job.partido_torneo_id, torneo_id: job.torneo_id, marcador: { a: Number(facts.board.score_a), b: Number(facts.board.score_b), sets_a: Number(facts.board.sets_a), sets_b: Number(facts.board.sets_b) }, observed: anon.payload };
    let ai = null, errorCode = null;
    try {
      const { reply } = await aiProvider.completeChat({ system: SYSTEM, userMessage: JSON.stringify(user), maxTokens: Math.min(512, prompt?.maxTokens || 512) });
      const parsed = JSON.parse(String(reply).replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      if (parsed && typeof parsed.title === 'string' && typeof parsed.summary === 'string' && Array.isArray(parsed.highlights) && Array.isArray(parsed.disclaimers)) { const localized = localize(parsed, anon.labels); if (!/\b[AB][1-4]\b/.test(JSON.stringify(localized))) ai = localized; }
      else errorCode = 'AI_INVALID_JSON';
    } catch (error) { errorCode = error?.code || 'AI_PROVIDER_ERROR'; }
    if (!ai) {
      // Provider request may have been accepted even on timeout; never auto-retry.
      await pool.query(`UPDATE nations_postmatch_ai.jobs SET status='uncertain', observed=$2::jsonb, error_code=$3, error_message='Provider response uncertain; no automatic retry', lease_token=NULL, lease_until=NULL, updated_at=now() WHERE scoreboard_id=$1 AND lease_token=$4 AND status='provider_started'`, [job.scoreboard_id, JSON.stringify(observed), errorCode, token]);
      return { status: 'uncertain', scoreboard_id: job.scoreboard_id, reason: errorCode };
    }
    const summary = ai;
    const saved = await pool.query(`UPDATE nations_postmatch_ai.jobs SET status='ready', observed=$2::jsonb, summary=$3::jsonb, provider=$4, model=$5, error_code=NULL, error_message=NULL, lease_token=NULL, lease_until=NULL, updated_at=now() WHERE scoreboard_id=$1 AND lease_token=$6 AND status='provider_started' RETURNING scoreboard_id`, [job.scoreboard_id, JSON.stringify(observed), JSON.stringify(summary), aiProvider.name || 'anthropic', process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', token]);
    if (!saved.rowCount) return { status: 'lease_lost', scoreboard_id: job.scoreboard_id };
    return { status: 'ready', scoreboard_id: job.scoreboard_id };
  } catch (error) {
    const code = /^[A-Z0-9_]{2,64}$/.test(error?.code || '') ? error.code : 'JOB_ERROR';
    await pool.query(`UPDATE nations_postmatch_ai.jobs SET status=$2, error_code=$3, error_message=$4, lease_token=NULL, lease_until=NULL, updated_at=now() WHERE scoreboard_id=$1 AND lease_token=$5`, [job.scoreboard_id, code === 'NATIONS_POSTMATCH_INSUFFICIENT_DATA' ? 'insufficient' : 'uncertain', code, String(error?.message || '').slice(0, 500), token]);
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
