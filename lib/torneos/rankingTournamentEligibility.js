/** Explicit QA marker, never inferred from names, accounts or point amounts. */
export function rankingTournamentEligible(torneo) {
  return torneo?.es_prueba !== true;
}
