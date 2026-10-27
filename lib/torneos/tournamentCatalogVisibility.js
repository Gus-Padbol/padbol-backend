function localIsoDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Public catalogues are for tournaments a player can still join or follow.
 * Completed events remain available through the dedicated history endpoints.
 */
export function canReadPublicTournamentCatalogRow(row, audience, now = new Date()) {
  if (audience) return true;
  const endDate = String(row?.fecha_fin ?? '').slice(0, 10);
  return !endDate || endDate >= localIsoDate(now);
}
