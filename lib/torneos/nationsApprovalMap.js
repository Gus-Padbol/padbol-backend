/** Mapa torneo_id -> roster_publication_approved, autoritativo desde el activation event. */
export async function fetchNationsApprovalMap(db, torneoIds = []) {
  const ids = [...new Set((torneoIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const base = db.from('nations_activation_events').select('torneo_id,roster_publication_approved');
  const { data, error } = ids.length ? await base.in('torneo_id', ids) : await base;
  if (error) throw error;
  const map = new Map();
  for (const row of data || []) if (row?.torneo_id != null) map.set(Number(row.torneo_id), row.roster_publication_approved === true);
  return map;
}
