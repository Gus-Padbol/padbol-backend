const CODE = 'CLASE_OCUPACION_GESTION_CLASES';
const MESSAGE = 'Esta ocupación pertenece a una clase. Usá la gestión de clases para modificar o cancelar el turno.';

export function classBookingGuardRejection(error) {
  return String(error?.message || '').includes(CODE) ? { status: 409, error: MESSAGE, code: CODE } : null;
}

// A historical occurrence remains internal too: cancelled class bookings must
// never become generic checkout resources. No provider/configuration is touched.
export async function assertReservaNotClassOccurrencePg(pool, reservaId) {
  if (reservaId == null) return;
  if (!pool?.query) throw Object.assign(new Error('Clases temporalmente no disponibles'), { status: 503 });
  const { rows: tables } = await pool.query("SELECT to_regclass('public.clases_ocurrencias') AS relation");
  if (!tables[0]?.relation) return; // Before the additive class schema, no link can exist.
  const { rows } = await pool.query('SELECT id FROM public.clases_ocurrencias WHERE reserva_cancha_id=$1 LIMIT 1', [reservaId]);
  if (rows.length) throw Object.assign(new Error(MESSAGE), { status: 409, code: CODE });
}
