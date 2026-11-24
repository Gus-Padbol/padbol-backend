// QA contract: NG request UUID -> persisted canonical PP bigint FK. Never cast UUIDs to numeric PP IDs.
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
export function mappingError(code, status = 409) { return Object.assign(new Error('La sede de la jornada requiere una vinculación canónica válida.'), { code, status }); }
export async function loadMappedRequests(db, canonicalId = null) {
  let query = db.from('ng_solicitudes_sede').select('id,canonical_sede_id,sede_club,ciudad,pais,nombre,email,whatsapp,estado,created_at,updated_at');
  if (canonicalId != null) query = query.eq('canonical_sede_id', Number(canonicalId));
  const result = await query.limit(1001);
  if (result.error || !Array.isArray(result.data) || result.data.length > 1000) throw mappingError('NG_VENUE_MAPPING_UNAVAILABLE', 503);
  return result.data;
}
export function sessionDto(row, requests, { allowUnlinked = false } = {}) {
  const request = requests.find(item => String(item.id) === String(row.sede_id));
  const canonical = request?.canonical_sede_id;
  if (!Number.isSafeInteger(Number(canonical)) || Number(canonical) <= 0) {
    if (allowUnlinked) return { ...row, sede_id: null, venue_request_id: row.sede_id, mapping_error: 'NG_VENUE_UNLINKED' };
    throw mappingError('NG_VENUE_UNLINKED');
  }
  return { ...row, sede_id: Number(canonical), venue_request_id: row.sede_id };
}
export async function canonicalSession(db, row) {
  const result = await db.from('ng_solicitudes_sede').select('id,canonical_sede_id').eq('id', row.sede_id).maybeSingle();
  if (result.error) throw mappingError('NG_VENUE_MAPPING_UNAVAILABLE', 503);
  return sessionDto(row, result.data ? [result.data] : []);
}
export async function resolveVenueRequest(db, canonicalId, requestId = null) {
  if (requestId != null && !uuid(requestId)) throw mappingError('NG_VENUE_REQUEST_INVALID', 400);
  if (requestId != null) requestId = String(requestId).toLowerCase();
  const requests = await loadMappedRequests(db, canonicalId);
  const matches = requestId ? requests.filter(row => row.id === requestId) : requests;
  if (!matches.length) throw mappingError('NG_VENUE_UNLINKED');
  if (matches.length !== 1) throw mappingError('NG_VENUE_AMBIGUOUS');
  return matches[0].id;
}
