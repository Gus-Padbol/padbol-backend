import { verifiedSuspendedBookings } from '../verifiedSuspendedBookings.js';

function clasesMinutosDesdeHora(raw) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(raw || '').split(' - ')[0].trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function createClasesAssertReservaSinSolape(supabaseAdmin) {
  return async function clasesAssertReservaSinSolape({ sede, fecha, hora, cancha, duracionMin, excludeId = null }) {
    const inicio = clasesMinutosDesdeHora(hora);
    if (inicio == null) throw Object.assign(new Error('Horario inválido'), { status: 400 });
    let query = supabaseAdmin.from('reservas').select('id,hora,duracion_minutos,estado,tipo')
      .eq('sede', sede).eq('fecha', fecha).eq('cancha', Number(cancha));
    if (excludeId != null && String(excludeId).trim()) query = query.neq('id', excludeId);
    const { data, error } = await query;
    if (error) throw error;
    const duracion = Number(duracionMin) > 0 ? Number(duracionMin) : 90;
    const released = await verifiedSuspendedBookings(supabaseAdmin, data);
    const conflict = (data || []).some((row) => {
      if (String(row.estado || '').toLowerCase() === 'cancelada' || released.has(String(row.id))) return false;
      const otroInicio = clasesMinutosDesdeHora(row.hora);
      if (otroInicio == null) return false;
      const otraDuracion = Number(row.duracion_minutos) > 0
        ? Number(row.duracion_minutos) : 90;
      return inicio < otroInicio + otraDuracion && inicio + duracion > otroInicio;
    });
    if (conflict) throw Object.assign(new Error('Este horario se solapa con otra reserva'), { status: 409 });
  }
}
