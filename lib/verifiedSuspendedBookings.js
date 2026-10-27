// A missing or failed verification leaves the booking occupied.
export async function verifiedSuspendedBookings(db, rows) {
  const ids = [...new Set((rows || []).filter(row => String(row?.estado || '').toLowerCase() === 'suspendida').map(row => row.id).filter(id => id != null))];
  if (!ids.length) return new Set();
  try {
    const { data, error } = await db.rpc('scoreboard_verified_suspended_bookings_candidate', { p_ids: ids });
    if (error || !Array.isArray(data)) return new Set();
    const candidates = new Set(ids.map(String));
    return new Set(data.map(row => String(row?.booking_id)).filter(id => candidates.has(id)));
  } catch {
    return new Set();
  }
}
