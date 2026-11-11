/** Pure candidate: verified completed games, never clock time. No DB or ranking writes. */
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const validId = (x) => typeof x === 'string' && x.trim().length > 0;

// The caller must derive these values from authoritative scoreboard state, not request body.
// Boundary policy must be explicitly confirmed by the competition owner; no default interpretation.
export function canSubstituteAtGameBoundary({ completedGamesInSet, pointInProgress, matchStatus, boundaryPolicy }) {
  if (!['after_odd_game', 'before_odd_game'].includes(boundaryPolicy)) return false;
  const game = boundaryPolicy === 'after_odd_game' ? completedGamesInSet : completedGamesInSet + 1;
  return matchStatus === 'open' && pointInProgress === false &&
    Number.isSafeInteger(completedGamesInSet) && completedGamesInSet >= 0 && game > 0 && game % 2 === 1;
}

/** Per-team tournament games ledger. Every completed game has exactly two active players. */
export function computeGamesParticipation({ roster, matches, fullPointsThreshold = 0.5 }) {
  if (!Array.isArray(roster) || roster.length < 2 || roster.length > 8 ||
      roster.some(id => !validId(id)) || new Set(roster).size !== roster.length) fail('ROSTER_INVALID');
  if (!Array.isArray(matches)) fail('MATCHES_INVALID');
  if (fullPointsThreshold !== 0.5) fail('THRESHOLD_UNSUPPORTED');
  const totals = Object.fromEntries(roster.map(id => [id, 0]));
  const matchIds = new Set();
  let totalGames = 0;
  for (const match of matches) {
    if (!validId(match?.id) || matchIds.has(match.id)) fail('MATCH_ID_INVALID_OR_DUPLICATE');
    matchIds.add(match.id);
    // No estimate for missing or interrupted matches; a walkover is explicitly zero games.
    if (match.status !== 'completed' && match.status !== 'walkover') fail('MATCH_NOT_CONFIRMED');
    if (!Array.isArray(match.games)) fail('GAME_LEDGER_MISSING');
    if (match.status === 'walkover' && match.games.length !== 0) fail('WALKOVER_HAS_GAMES');
    if (match.status === 'completed' && match.games.length === 0) fail('COMPLETED_MATCH_EMPTY');
    let previousSet = 0, previousGame = 0;
    const gameIds = new Set();
    for (const game of match.games) {
      if (!validId(game?.id) || gameIds.has(game.id)) fail('GAME_ID_INVALID_OR_DUPLICATE');
      gameIds.add(game.id);
      if (!Number.isSafeInteger(game.set) || game.set < 1 || game.set > 3 ||
          !Number.isSafeInteger(game.number) || game.number < 1) fail('GAME_POSITION_INVALID');
      if (game.set === previousSet) {
        if (game.number !== previousGame + 1) fail('GAME_LEDGER_GAP');
      } else if (game.set !== previousSet + 1 || game.number !== 1) fail('GAME_LEDGER_GAP');
      if (game.completed !== true) fail('GAME_NOT_CONFIRMED');
      const pair = game.players;
      if (!Array.isArray(pair) || pair.length !== 2 || new Set(pair).size !== 2 ||
          pair.some(id => !Object.hasOwn(totals, id))) fail('GAME_LINEUP_INVALID');
      for (const id of pair) totals[id]++;
      totalGames++;
      previousSet = game.set; previousGame = game.number;
    }
  }
  if (!totalGames) return { status: 'unconfirmed', reason: 'NO_PLAYED_GAMES', totalGames: 0, players: null };
  return {
    status: 'confirmed', basis: 'completed_games', fullPointsThreshold,
    totalGames,
    players: roster.map(id => ({ id, gamesPlayed: totals[id], percentage: 100 * totals[id] / totalGames,
      pointsFactor: Math.min(1, totals[id] / (totalGames * fullPointsThreshold)) }))
  };
}
