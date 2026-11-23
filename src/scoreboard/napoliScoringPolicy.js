/** Server-owned rules. Call only with persisted tournament/match rows. */
export const NAPOLI_GROUPS_POLICY_ID = 'napoli_groups_super_tiebreak_10_v1';
export const NAPOLI_GROUPS_POLICY = Object.freeze({ id: NAPOLI_GROUPS_POLICY_ID, phase: 'groups', best_of: 3, deciding_set: 'super_tiebreak', target: 10, win_by: 1 });
export function isIsolatedQaScoringCandidate(tournament, env = process.env) {
  return env.BACKEND_RUNTIME_MODE === 'staging' && env.SUPABASE_URL === 'https://vxikhdulhuvghfqeutnp.supabase.co'
    && tournament?.es_prueba === true;
}
export function resolvePersistedScoringPolicy(tournament, match, env = process.env, persistedQaPlan = null) {
  if (!tournament || !match || String(match.torneo_id) !== String(tournament.id)) return null;
  if (String(tournament.deporte).toLowerCase() !== 'padbol' || tournament.modalidad_plantel !== 'selecciones') return null;
  const productionNapoli = String(tournament.id) === '57' && env.BACKEND_RUNTIME_MODE !== 'staging'
    && typeof env.SUPABASE_URL === 'string' && env.SUPABASE_URL.replace(/\/$/, '') === 'https://vpldffhsxhgnmitiikof.supabase.co';
  const isolatedQa = isIsolatedQaScoringCandidate(tournament, env) && persistedQaPlan?.config?.scoring_policy === NAPOLI_GROUPS_POLICY_ID;
  if (!productionNapoli && !isolatedQa) return null;
  if (!['A', 'B', 'C'].includes(match.grupo) || Number(match.ronda) !== 1
    || [match.bracket_round, match.bracket_position, match.partido_siguiente_id, match.partido_siguiente_slot].some(value => value != null)) return null;
  return NAPOLI_GROUPS_POLICY;
}
export function isNapoliGroupsPolicy(policy) {
  return policy?.id === NAPOLI_GROUPS_POLICY_ID && policy.phase === 'groups' && policy.best_of === 3
    && policy.deciding_set === 'super_tiebreak' && policy.target === 10 && policy.win_by === 1;
}
export function isDecidingSuperTiebreak(row, policy) {
  return isNapoliGroupsPolicy(policy) && row.estado !== 'terminado' && row.estado !== 'finalizado'
    && Number(row.sets_a) === 1 && Number(row.sets_b) === 1 && row.historial_sets?.length === 2
    && Number(row.games_a) === 0 && Number(row.games_b) === 0;
}
