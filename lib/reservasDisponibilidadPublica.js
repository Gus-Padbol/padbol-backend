import { filterBlockingReservas } from '../routes/partidos.js';

const columns = 'id,hora,hora_inicio,hora_fin,cancha,cancha_id,estado,created_at,sede,sede_id,duracion_minutos';

export async function readPublicReservationOccupancy(admin, { sede, sedeId, fecha }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
    throw Object.assign(new Error('Fecha inválida'), { status: 400 });
  }
  let lookup = admin.from('sedes').select('id,nombre');
  lookup = sedeId ? lookup.eq('id', sedeId) : lookup.eq('nombre', sede);
  const { data: venues, error } = await lookup.limit(2);
  if (error) throw error;
  if (!venues?.length) throw Object.assign(new Error('Sede no encontrada'), { status: 404 });
  if (venues.length !== 1) throw Object.assign(new Error('Indica sede_id para identificar la sede'), { status: 400 });
  const venue = venues[0];
  const results = await Promise.all([
    admin.from('reservas').select(columns).eq('sede_id', venue.id).eq('fecha', fecha),
    admin.from('reservas').select(columns).eq('sede', venue.nombre).is('sede_id', null).eq('fecha', fecha),
  ]);
  const failed = results.find(result => result.error);
  if (failed) throw failed.error;
  const unique = new Map(results.flatMap(result => result.data ?? []).map(row => [row.id, row]));
  // Only the occupancy contract is public; never forward player, contact or payment data.
  return filterBlockingReservas([...unique.values()]).map(row => Object.fromEntries(
    columns.split(',').filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]),
  ));
}
