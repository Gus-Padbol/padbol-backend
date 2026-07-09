import { sumarXP } from '../xp/xpService.js';
import { partidoTieneResultadoCargado } from '../partidos/resultadoService.js';
import { reservaHoraFinFromRow } from '../../utils/reservasColumns.js';
import { sendPushToUser } from '../../utils/push.js';
import { processReservationPadcoinsOnComplete } from '../matches/matchRewardsService.js';

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

function isMissingColumn(error, columnName) {
  const message = String(error?.message ?? '').toLowerCase();
  const col = String(columnName ?? '').toLowerCase();
  return message.includes(col) && (message.includes('column') || message.includes('does not exist'));
}

async function fetchReservasPendientesCompletar(supabaseAdmin, nowAR) {
  const today = nowAR.toISOString().slice(0, 10);
  const selectCols = `
    id, user_id, sede, sede_id, fecha, hora, hora_fin, hora_inicio,
    partido_id, notificacion_post_partido_enviada,
    precio, precio_esperado, monto_pagado, moneda, pago_estado
  `;

  let { data, error } = await supabaseAdmin
    .from('reservas')
    .select(selectCols)
    .eq('estado', 'confirmada')
    .eq('notificacion_post_partido_enviada', false)
    .lte('fecha', today);

  if (error && isMissingColumn(error, 'notificacion_post_partido_enviada')) {
    ({ data, error } = await supabaseAdmin
      .from('reservas')
      .select(`
        id, user_id, sede, sede_id, fecha, hora, hora_fin, hora_inicio, partido_id,
        precio, precio_esperado, monto_pagado, moneda, pago_estado
      `)
      .eq('estado', 'confirmada')
      .lte('fecha', today));
  }

  if (error) throw error;

  return (data ?? []).filter((reserva) => {
    const horaFin = reservaHoraFinFromRow(reserva);
    return reservaYaFinalizo(reserva.fecha, horaFin, nowAR);
  });
}

async function resolvePartidoForReserva(supabaseAdmin, reserva) {
  if (reserva.partido_id != null) {
    const { data, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, capitan_user_id, resultado_json, resultado, estado')
      .eq('id', reserva.partido_id)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, resultado_json, resultado, estado')
    .eq('reserva_id', reserva.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function enviarPushPostPartidoCapitan(supabaseAdmin, partido) {
  if (!partido?.capitan_user_id || partidoTieneResultadoCargado(partido)) {
    return false;
  }

  await sendPushToUser(supabaseAdmin, partido.capitan_user_id, {
    title: '¿Cómo salió el partido?',
    body: 'Cargá el resultado y sumá XP a tu perfil',
    data: {
      type: 'cargar_resultado',
      partido_id: String(partido.id),
    },
  }).catch((err) => {
    console.warn(`⚠️ Push post-partido partido ${partido.id}:`, err.message);
  });

  return true;
}

export async function procesarReservasCompletadas(supabaseAdmin) {
  const nowAR = getNowArgentina();
  const pendientes = await fetchReservasPendientesCompletar(supabaseAdmin, nowAR);

  if (!pendientes.length) return;

  console.log(`⏰ Cron reservas completadas: ${pendientes.length} reserva(s) pendiente(s)`);

  for (const reserva of pendientes) {
    try {
      const sede = reserva.sede ?? 'tu sede';
      const partido = await resolvePartidoForReserva(supabaseAdmin, reserva);
      const partidoId = partido?.id ?? reserva.partido_id ?? null;

      let pushEnviado = false;
      if (partidoId && partido) {
        pushEnviado = await enviarPushPostPartidoCapitan(supabaseAdmin, partido);
      }

      const updatePayload = { estado: 'completada' };
      if (partidoId) {
        updatePayload.notificacion_post_partido_enviada = true;
        if (!reserva.partido_id) {
          updatePayload.partido_id = partidoId;
        }
      }

      const { error: updateErr } = await supabaseAdmin
        .from('reservas')
        .update(updatePayload)
        .eq('id', reserva.id)
        .eq('estado', 'confirmada');

      if (updateErr) {
        if (isMissingColumn(updateErr, 'notificacion_post_partido_enviada')) {
          const { error: fallbackErr } = await supabaseAdmin
            .from('reservas')
            .update({ estado: 'completada' })
            .eq('id', reserva.id)
            .eq('estado', 'confirmada');
          if (fallbackErr) throw fallbackErr;
        } else {
          throw updateErr;
        }
      }

      if (reserva.user_id) {
        await sumarXP(
          supabaseAdmin,
          reserva.user_id,
          'RESERVA_COMPLETADA',
          `Reserva completada en ${sede}`,
          String(reserva.id),
        ).catch((err) => console.warn(`⚠️ XP reserva ${reserva.id}:`, err.message));

        const padcoinsResult = await processReservationPadcoinsOnComplete(
          supabaseAdmin,
          reserva,
          partido,
        ).catch((err) => {
          console.warn(`⚠️ PadCoins reserva ${reserva.id}:`, err.message);
          return null;
        });

        if (padcoinsResult?.acreditado) {
          console.log(
            `✓ PadCoins reserva ${reserva.id} — +${padcoinsResult.padcoins} (${padcoinsResult.method}) [${padcoinsResult.mode ?? 'organizer_only'}]`,
          );
        } else if (padcoinsResult?.mode === 'match_deferred') {
          console.log(
            `⏸ PadCoins reserva ${reserva.id} diferidos — partido ${partidoId} vinculado; recompensa tras validación de resultado`,
          );
        }
      }

      console.log(
        `✓ Reserva ${reserva.id} completada`
        + (partidoId ? ` — push capitan ${pushEnviado ? 'ok' : 'omitido'}` : ''),
      );
    } catch (err) {
      console.warn(`⚠️ Cron reserva ${reserva.id}:`, err.message);
    }
  }
}

export function initReservasCron({ supabaseAdmin, cron, timezone = TZ_RESERVA }) {
  cron.schedule(
    '*/5 * * * *',
    async () => {
      try {
        await procesarReservasCompletadas(supabaseAdmin);
      } catch (err) {
        console.error('❌ Cron reservas completadas - error inesperado:', err.message);
      }
    },
    { timezone },
  );

  procesarReservasCompletadas(supabaseAdmin).catch((err) => {
    console.warn('⚠️ Cron reservas completadas (arranque):', err.message);
  });

  console.log('⏰ Cron reservas completadas registrado (cada 5 min)');
}
