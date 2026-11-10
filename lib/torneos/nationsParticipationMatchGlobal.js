import {appendMarkerEvent} from './nationsParticipationMarker.js';
/** Comando global de partido: aplica a ambos equipos con el mismo serverAt o falla entero. */
export function applyMatchGlobalCommand({states, command, now, actorId, idempotencyKey}) {
  if (!states || typeof states !== 'object' || Object.keys(states).length !== 2) throw Object.assign(new Error('MATCH_TEAMS_REQUIRED'), {code:'MATCH_TEAMS_REQUIRED'});
  if (!['pause','resume','close'].includes(command)) throw Object.assign(new Error('GLOBAL_COMMAND_INVALID'), {code:'GLOBAL_COMMAND_INVALID'});
  if (!idempotencyKey) throw Object.assign(new Error('IDEMPOTENCY_KEY_REQUIRED'), {code:'IDEMPOTENCY_KEY_REQUIRED'});
  const next = {}; const events = {};
  for (const [teamId, state] of Object.entries(states)) {
    const eventId = `${idempotencyKey}:${teamId}`;
    const r = appendMarkerEvent(state, {type:command, eventId, idempotencyKey:eventId, reason:'match-global'}, {expectedRevision:state.revision, now, actorId});
    next[teamId] = r.state; events[teamId] = r.event;
  }
  return {states: next, events};
}
