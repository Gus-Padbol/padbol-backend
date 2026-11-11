/** Candidate integration bridge: invoke inside the SAME scoring transaction as scoreboard_commit_mutation.
 * Never use a second write after score commit: that loses games on timeouts/retries.
 * Inputs must be DB-locked snapshots. Clock fields are neither read nor written.
 */
const fail = code => { throw Object.assign(new Error(code), { code }); };
const number = n => { if (!Number.isSafeInteger(n) || n < 0) fail('SCORE_INVALID'); return n; };
function position(row) {
  if (!Array.isArray(row.historial_sets)) fail('SETS_MISSING');
  const sets = row.historial_sets.map((s,i) => {
    if (s.set !== i + 1) fail('SET_SEQUENCE_INVALID');
    return { set: s.set, a: number(s.a), b: number(s.b) };
  });
  const current = number(row.games_a) + number(row.games_b);
  return { sets, current, total: sets.reduce((n,s)=>n+s.a+s.b,0)+current };
}
export function prepareCompletedGame({ before, after, activePlayers, eventId }) {
  if (!before?.id || before.id !== after?.id || typeof eventId !== 'string' || !eventId.trim()) fail('MATCH_EVENT_INVALID');
  const a=position(before), b=position(after);
  const delta=b.total-a.total;
  if (delta < 0) fail('GAME_UNDO_REQUIRES_LEDGER_REVERSAL');
  if (delta > 1) fail('GAME_LEDGER_GAP');
  if (b.sets.length < a.sets.length || b.sets.length > a.sets.length+1 ||
      a.sets.some((s,i)=>JSON.stringify(s)!==JSON.stringify(b.sets[i]))) fail('SET_HISTORY_CHANGED');
  if (!delta) return null;
  if (!Array.isArray(activePlayers) || activePlayers.length!==2 ||
      new Set(activePlayers).size!==2 || activePlayers.some(id=>typeof id!=='string'||!id.trim())) fail('GAME_LINEUP_INVALID');
  return { id: eventId, set: a.sets.length+1, number: a.current+1, completed: true, players:[...activePlayers] };
}
