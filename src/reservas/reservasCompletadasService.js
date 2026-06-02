import { sumarXP } from '../xp/xpService.js';
import {
  notifyCapitanesCargarResultado,
  partidoTieneResultadoCargado,
} from '../partidos/resultadoService.js';
import { reservaHoraFinFromRow } from '../../utils/reservasColumns.js';

const TZ_RESERVA = 'America/Argentina/Buenos_Aires';

function getNowArgentina() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ_RESERVA }));
}

function reservaYaFinalizo(fecha, horaFin, nowAR) {
  const fy = String(fecha ?? '').trim().slice(0, 10);
  const hf = String(horaFin ?? '').trim().slice(0, 5);
  if (!fy || !hf) return false;

  const endDt = new Date(`${fy}T${hf}:00-03:00`);
  if (Number.isNaN(endDt.getTime())) return false;

  return endDt.getTime() <= nowAR.getTime();
}

export async function procesarReservaCompletada(supabaseAdmin, reserva) {
  const sede = reserva.sede ?? 'tu sede';

  if (reserva.user_id) {
    await sumarXP(
      supabaseAdmin,
      reserva.user_id,
      'RESERVA_COMPLETADA',
      `Reserva completada en ${sede}`,
      String(reserva.id),
    ).catch((err) => console.warn(`⚠️ XP reserva ${reserva.id}:`, err.message));
  }

  const { data: partido, error: partidoErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, resultado_json, resultado, estado')
    .eq('reserva_id', reserva.id)
    .in('estado', ['completo', 'abierto'])
    .maybeSingle();

  if (partidoErr) {
    console.warn(`⚠️ Partido reserva ${reserva.id}:`, partidoErr.message);
    return;
  }

  if (partido && !partidoTieneResultadoCargado(partido)) {
    await notifyCapitanesCargarResultado(supabaseAdmin, partido.id);
  }
}

export async function runReservasCompletadasCron(supabaseAdmin) {
  const nowAR = getNowArgentina();
  const today = nowAR.toISOString().slice(0, 10);

  const { data: reservas, error } = await supabaseAdmin
    .from('reservas')
    .select('id, user_id, sede, fecha, hora, hora_fin, hora_inicio, estado')
    .eq('estado', 'confirmada')
    .lte('fecha', today);

  if (error) {
    console.error('❌ Cron reservas completadas - error Supabase:', error.message);
    return;
  }

  const pendientes = (reservas ?? []).filter((r) => {
    const horaFin = reservaHoraFinFromRow(r);
    return reservaYaFinalizo(r.fecha, horaFin, nowAR);
  });

  if (!pendientes.length) return;

  console.log(`⏰ Cron: ${pendientes.length} reserva(s) completada(s)`);

  for (const reserva of pendientes) {
    try {
      const { error: updateErr } = await supabaseAdmin
        .from('reservas')
        .update({ estado: 'completada' })
        .eq('id', reserva.id)
        .eq('estado', 'confirmada');

      if (updateErr) throw updateErr;

      await procesarReservaCompletada(supabaseAdmin, reserva);
      console.log(`✓ Reserva ${reserva.id} completada — XP y notificaciones procesadas`);
    } catch (err) {
      console.warn(`⚠️ Reserva completada ${reserva.id}:`, err.message);
    }
  }
}
