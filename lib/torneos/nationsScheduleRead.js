/** Pure read/order helpers for the 38 reference slots. No writes or auto-start. */
const key = value => value == null ? '' : String(value);
const order = value => Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;

/** A live board always wins. Otherwise the first pending slot by explicit court order wins. */
export function selectCourtNext({ boards = [], slots = [], matches = [], courtLabel }) {
  const live = (boards || []).find(board => ['en_curso','activo'].includes(String(board.estado || '').toLowerCase()));
  if (live) return {kind:'live', board:live, slot:null, match:null};
  const pendingSlots = (slots || [])
    .filter(slot => key(slot.court_label) === key(courtLabel))
    .filter(slot => slot.partido_id != null)
    .filter(slot => !(boards || []).some(board => key(board.partido_torneo_id) === key(slot.partido_id) && ['en_curso','activo'].includes(String(board.estado || '').toLowerCase())))
    .sort((a,b) => order(a.orden) - order(b.orden));
  const unavailable = new Set(['finalizado','terminado','anulado','cancelado','suspendido']);
  for (const slot of pendingSlots) {
    const match = (matches || []).find(m => key(m.id) === key(slot.partido_id));
    if (match && !unavailable.has(String(match.estado || '').toLowerCase())) return {kind:'next', board:null, slot, match};
  }
  // Legacy fallback: only already-created boards, ordered by numeric schedule slot then created_at.
  const slotOrder = new Map((slots || []).filter(s=>s.partido_id!=null).map(s=>[key(s.partido_id), order(s.orden)]));
  const pendingBoards = (boards || []).filter(board => String(board.estado || '').toLowerCase() === 'pendiente')
    .sort((a,b) => (slotOrder.get(key(a.partido_torneo_id)) ?? Number.MAX_SAFE_INTEGER) - (slotOrder.get(key(b.partido_torneo_id)) ?? Number.MAX_SAFE_INTEGER)
      || String(a.created_at || '').localeCompare(String(b.created_at || '')) || key(a.id).localeCompare(key(b.id)));
  return pendingBoards[0] ? {kind:'next-board', board:pendingBoards[0], slot:null, match:null} : {kind:'none', board:null, slot:null, match:null};
}

/** DTO for a prepared match without a scoreboard yet; it never carries a score. */
export function preparedNextMatchDto(match, slot) {
  if (!match || !slot) return null;
  return {
    id: null,
    partido_torneo_id: Number(match.id),
    estado: 'pendiente',
    cancha: String(slot.court_label),
    fecha_hora: match.fecha_hora || slot.inicio || null,
    equipo_a_nombre: match.equipo_a_nombre || null,
    equipo_b_nombre: match.equipo_b_nombre || null,
    equipo_a_pais_iso: match.equipo_a_pais_iso || null,
    equipo_b_pais_iso: match.equipo_b_pais_iso || null,
    a: {nombre: match.equipo_a_nombre || null, pais_iso: match.equipo_a_pais_iso || null},
    b: {nombre: match.equipo_b_nombre || null, pais_iso: match.equipo_b_pais_iso || null},
    next_slot: slot.slot_key,
    schedule_order: Number(slot.orden),
    starts: 'referee',
  };
}
