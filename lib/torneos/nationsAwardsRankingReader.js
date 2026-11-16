/** Pure merge rules for /api/rankings: awarded Nations events replace legacy point rows. */
export function confirmedAwardEventIds(plans = []) {
  return new Set((plans || []).filter(row => row?.plan?.award_policy?.confirmed === true).map(row => String(row.torneo_id)));
}
export function legacyRowsForRanking(rows, confirmedIds) {
  return (rows || []).filter(row => !confirmedIds.has(String(row.torneo_id)));
}
export function awardEntry(award) {
  const points = Number(award?.points);
  if (award?.status !== 'awarded' || !award?.player_id || !Number.isFinite(points)) return null;
  return {key:String(award.player_id), torneoId:String(award.torneo_id), points, nombre:String(award.player_name || award.player_id), source:'nations_awards'};
}
export function mergeAwardIntoPlayerMap(playerMap, award) {
  const entry = awardEntry(award);
  if (!entry) return playerMap;
  if (!playerMap[entry.key]) playerMap[entry.key] = {nombre:entry.nombre,email:null,pais:null,foto_url:null,nivel:null,sede_id:null,equipo_nombre:null,puntos_total:0,torneos_count:0};
  playerMap[entry.key].puntos_total += entry.points;
  playerMap[entry.key].torneos_count += 1;
  return playerMap;
}
