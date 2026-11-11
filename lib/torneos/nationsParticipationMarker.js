/** Marcador Nations: timeline append-only, reloj/autor/eventId confiados al servidor, sin DB. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const canon = (e) => JSON.stringify([e.type, e.eventId, e.outId ?? null, e.inId ?? null, e.targetEventId ?? null, e.patch ?? null, e.reason ?? null]);
const copy = (x) => JSON.parse(JSON.stringify(x));

export function createMarkerState({ lineup, startedAt, matchId = null }) {
  const iniciales = lineup?.iniciales || []; const suplentes = lineup?.suplentes || [];
  const roster = [...iniciales, ...suplentes];
  if (iniciales.length !== 2 || suplentes.length > 2 || roster.length < 2 || roster.length > 4 || new Set(roster).size !== roster.length || roster.some((id) => !UUID.test(id))) fail('LINEUP_INVALID');
  if (!Number.isFinite(Number(startedAt)) || Number(startedAt) < 0) fail('STARTED_AT_INVALID');
  return { revision: 0, matchId, lineup: { iniciales: [...iniciales], suplentes: [...suplentes] }, roster: [...roster], startedAt: Number(startedAt), status: 'open', active: [...iniciales], events: [], corrections: [], closedAt: null, pausedAt: null };
}

export function appendMarkerEvent(state, input, { expectedRevision, now, actorId } = {}) {
  if (now === null || now === undefined || !Number.isFinite(Number(now))) fail('SERVER_CLOCK_REQUIRED');
  if (typeof actorId !== 'string' || !actorId.trim()) fail('SERVER_ACTOR_REQUIRED');
  if (typeof input?.eventId !== 'string' || !input.eventId.trim()) fail('EVENT_ID_REQUIRED');
  const key = String(input.idempotencyKey ?? '').trim(); if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
  const principal = actorId.trim();
  const existing = state.events.find((e) => e.idempotencyKey === key);
  if (existing) {
    if (existing.actorId !== principal || canon(existing) !== canon(input)) fail('IDEMPOTENCY_CONFLICT');
    return { state, event: existing, deduplicated: true }; // dedup ANTES de CAS
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) fail('REVISION_CONFLICT');
  const at = Number(now);
  if (state.closedAt !== null && at < state.closedAt) fail('OUT_OF_ORDER');
  const last = state.events[state.events.length - 1];
  if (last && at < last.serverAt) fail('OUT_OF_ORDER');
  if (state.events.some((e) => e.eventId === input.eventId)) fail('EVENT_ID_DUPLICATE');
  const event = { eventId: input.eventId, type: input.type, idempotencyKey: key, outId: input.outId ?? null, inId: input.inId ?? null, targetEventId: input.targetEventId ?? null, patch: input.patch ? copy(input.patch) : null, reason: input.reason ?? null, actorId: principal, serverAt: at, revision: state.revision + 1 };
  const next = { ...state, events: [...state.events, event], revision: state.revision + 1 };
  if (input.type === 'pause') {
    if (state.status !== 'open') fail('PAUSE_INVALID');
    next.status = 'paused'; next.pausedAt = at;
  } else if (input.type === 'resume') {
    if (state.status !== 'paused') fail('RESUME_INVALID');
    next.status = 'open'; next.pausedAt = null;
  } else if (input.type === 'substitution') {
    if (state.status !== 'open') fail('SUBSTITUTION_NOT_OPEN');
    if (!state.active.includes(input.outId)) fail('OUT_NOT_ACTIVE');
    if (state.active.includes(input.inId)) fail('IN_ALREADY_ACTIVE');
    if (!state.roster.includes(input.inId)) fail('IN_NOT_IN_LINEUP');
    next.active = state.active.map((id) => (id === input.outId ? input.inId : id));
  } else if (input.type === 'close') {
    if (state.status === 'closed') fail('MARKER_CLOSED');
    next.status = 'closed'; next.closedAt = at; next.pausedAt = state.status === 'paused' ? at : state.pausedAt;
  } else if (input.type === 'correction') {
    if (!state.events.some((e) => e.eventId === input.targetEventId)) fail('CORRECTION_TARGET_INVALID');
    if (!String(input.reason || '').trim()) fail('CORRECTION_REASON_REQUIRED');
    if (!input.patch || typeof input.patch !== 'object') fail('CORRECTION_PATCH_REQUIRED');
    const allowed = new Set(['outId', 'inId', 'serverAt', 'type']);
    if (Object.keys(input.patch).some((k) => !allowed.has(k))) fail('CORRECTION_PATCH_INVALID');
    next.corrections = [...state.corrections, { targetEventId: input.targetEventId, patch: copy(input.patch), actorId: principal, reason: input.reason, serverAt: at }];
    if (state.status === 'closed') next.status = 'corrected';
  } else fail('EVENT_INVALID');
  return { state: next, event, deduplicated: false };
}

function applyCorrections(events, corrections) {
  const byId = new Map(corrections.map((c) => [c.targetEventId, c.patch]));
  return events.map((e) => (e.type === 'correction' ? e : { ...e, ...(byId.get(e.eventId) || {}) }));
}

export function computeParticipation(state, lineup = state?.lineup, { now } = {}) {
  if (!state || !Number.isFinite(state.startedAt) || state.startedAt < 0) return { status: 'unconfirmed', reason: 'STARTED_AT_INVALID', players: null };
  if (!Array.isArray(state.roster) || state.roster.length < 2 || state.roster.length > 4 || new Set(state.roster).size !== state.roster.length) return { status: 'unconfirmed', reason: 'ROSTER_INVALID', players: null };
  if (!Array.isArray(lineup?.iniciales) || lineup.iniciales.length !== 2) return { status: 'unconfirmed', reason: 'LINEUP_INVALID', players: null };
  if (state.revision !== state.events.length) return { status: 'unconfirmed', reason: 'REVISION_GAP', players: null };
  if (state.status !== 'closed' && state.status !== 'corrected') return { status: 'unconfirmed', reason: 'MARKER_NOT_CLOSED', players: null };

  const ids = new Set();
  for (let i = 0; i < state.events.length; i++) {
    const e = state.events[i];
    if (e.revision !== i + 1) return { status: 'unconfirmed', reason: 'REVISION_GAP', players: null };
    if (ids.has(e.eventId)) return { status: 'unconfirmed', reason: 'EVENT_ID_DUPLICATE', players: null };
    ids.add(e.eventId);
  }
  // Correcciones son auditoria; la reproduccion temporal usa el timeline efectivo SIN correcciones.
  const effective = applyCorrections(state.events, state.corrections || []).filter((e) => e.type !== 'correction');
  const closes = effective.filter((e) => e.type === 'close');
  if (closes.length !== 1 || effective[effective.length - 1].type !== 'close') return { status: 'unconfirmed', reason: 'CLOSE_INCOMPLETE', players: null };
  const closedAt = effective[effective.length - 1].serverAt;
  if (!Number.isFinite(closedAt) || closedAt < state.startedAt) return { status: 'unconfirmed', reason: 'CLOSE_INVALID', players: null };
  if (now !== undefined && closedAt > now) return { status: 'unconfirmed', reason: 'CLOSE_IN_FUTURE', players: null };
  let active = [...lineup.iniciales]; let last = state.startedAt; let paused = false; let pausedMs = 0; let pauseStarted = null;
  if (active.length !== 2 || new Set(active).size !== 2 || active.some((id) => !state.roster.includes(id))) return { status: 'unconfirmed', reason: 'ACTIVE_INVALID', players: null };
  const totals = Object.fromEntries(state.roster.map((id) => [id, 0]));
  for (const e of effective) {
    if (!Number.isFinite(e.serverAt) || e.serverAt < last) return { status: 'unconfirmed', reason: 'TIME_INVALID', players: null };
    if (e.type === 'pause') {
      if (paused) return { status: 'unconfirmed', reason: 'PAUSE_INVALID', players: null };
      for (const id of active) totals[id] += e.serverAt - last; paused = true; pauseStarted = e.serverAt; last = e.serverAt;
    } else if (e.type === 'resume') {
      if (!paused) return { status: 'unconfirmed', reason: 'RESUME_INVALID', players: null };
      pausedMs += e.serverAt - pauseStarted; paused = false; pauseStarted = null; last = e.serverAt;
    } else if (e.type === 'substitution') {
      if (paused) return { status: 'unconfirmed', reason: 'SUBSTITUTION_DURING_PAUSE', players: null };
      if (!active.includes(e.outId) || !state.roster.includes(e.inId) || active.includes(e.inId)) return { status: 'unconfirmed', reason: 'SUBSTITUTION_INVALID', players: null };
      for (const id of active) totals[id] += e.serverAt - last;
      active = active.map((id) => (id === e.outId ? e.inId : id)); last = e.serverAt;
    } else if (e.type === 'close') {
      if (paused) pausedMs += e.serverAt - pauseStarted;
      else for (const id of active) totals[id] += e.serverAt - last;
      last = e.serverAt;
    } else if (e.type !== 'correction') return { status: 'unconfirmed', reason: 'EVENT_INVALID', players: null };
    if (active.length !== 2 || new Set(active).size !== 2) return { status: 'unconfirmed', reason: 'ACTIVE_INVALID', players: null };
  }
  if (Object.values(totals).some((v) => !Number.isFinite(v) || v < 0)) return { status: 'unconfirmed', reason: 'TIME_INVALID', players: null };
  const effectiveMatchMs = closedAt - state.startedAt - pausedMs;
  const msPlayers = state.roster.map((id) => ({ id, activeMs: totals[id] }));
  if (!Number.isFinite(effectiveMatchMs) || effectiveMatchMs <= 0) return { status: 'unconfirmed', reason: 'DURATION_ZERO', players: msPlayers, effectiveMatchMs: 0, percentageStatus: 'pending_definition' };
  return { status: 'confirmed', reason: null, players: msPlayers.map((p) => ({ ...p, percentage: (p.activeMs / effectiveMatchMs) * 100 })), effectiveMatchMs, percentageStatus: 'confirmed' };
}
