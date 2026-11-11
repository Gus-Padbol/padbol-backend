// Handler de POST /api/reservas extraído sin cambios de comportamiento.
// Las dependencias se inyectan desde server.js para no duplicar inicialización.
import {
  buildPartidoAbiertoInsertRow,
  buildCapitanFields,
  buildReservaInsertRow,
  classifyReservaWriteError,
  logPartidoCanchaBody,
  isCourtBlocked,
  parsePositiveInt,
  resolveReservaCanchaStorageText,
  resolvePartidoCanchaNombre,
} from '../routes/partidos.js';
import {assertJugadorNoSuspendidoPg} from '../routes/reputacion.js';
import {RESERVA_OWNER_SELECT, mapMisReservaRow} from './dto/reservaDto.js';
import {esSedeTorneo, errorSedeNoReservable} from './sedeTipo.js';

export function createReservaHandler({
  getAuthenticatedUser,
  supabaseAdmin,
  pgPool,
  computePartidoDeadlineCancel,
  sendHttpError,
}) {
  return async function crearReservaHandler(req, res) {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const {
        sede,
        sede_id: sedeIdBody,
        fecha,
        hora,
        cancha,
        cancha_id,
        cancha_nombre,
        canchaSeleccionada,
        nombre,
        email,
        whatsapp,
        telefono,
        nivel,
        nivel_partido,
        precio,
        duracion_minutos,
        modo_partido: modoPartidoRaw,
      } = req.body;

      const modoPartido = modoPartidoRaw === true || modoPartidoRaw === 'true';
      const authUser = user;

      if (modoPartido) {
        logPartidoCanchaBody(req.body, 'POST /api/reservas modo_partido');
      }

      const contactEmail = email ?? authUser.email;
      const contactWhatsapp = whatsapp ?? telefono ?? '';
      const contactNombre = nombre
        ?? authUser?.user_metadata?.full_name
        ?? authUser?.user_metadata?.name
        ?? authUser?.email
        ?? 'Jugador';

      if (!fecha || !hora || !contactEmail) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
      }

      if (!sede && !sedeIdBody) {
        return res.status(400).json({ error: 'Falta sede o sede_id' });
      }

      let sedeNombre = sede;
      let sedeId = parsePositiveInt(sedeIdBody);

      let sedeTipo = null;
      // La sede autoritativa se resuelve SIEMPRE por id: si el cuerpo trae sede+sede_id
      // juntos, antes se omitía la consulta y el guard quedaba evadido.
      if (sedeId != null) {
        const { data: sedeRow } = await supabaseAdmin
          .from('sedes')
          .select('nombre,tipo_sede')
          .eq('id', sedeId)
          .maybeSingle();
        sedeNombre = sedeRow?.nombre ?? sedeNombre ?? null;
        sedeTipo = sedeRow?.tipo_sede ?? null;
      }

      if (sedeId == null && sedeNombre) {
        const { data: sedeRow } = await supabaseAdmin
          .from('sedes')
          .select('id,tipo_sede')
          .eq('nombre', sedeNombre)
          .maybeSingle();
        sedeId = parsePositiveInt(sedeRow?.id);
        sedeTipo = sedeRow?.tipo_sede ?? null;
      }

      if (!sedeNombre) {
        return res.status(400).json({ error: 'Sede no encontrada' });
      }

      // Guard de servidor: una sede de torneo no admite reservas por hora.
      if (esSedeTorneo(sedeTipo)) {
        const rechazo = errorSedeNoReservable();
        return res.status(status && status >= 400 ? status : 409).json({ error: rechazo.error, code: rechazo.code });
      }

      const bookingUserId = authUser.id;
      if (bookingUserId && pgPool) {
        try {
          const susp = await assertJugadorNoSuspendidoPg(pgPool, bookingUserId);
          if (susp.suspendido) {
            const hasta = susp.suspendido_hasta
              ? new Date(susp.suspendido_hasta).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
              : null;
            return res.status(403).json({
              error: hasta
                ? `Tenés una suspensión activa por cancelaciones tardías. Podrás reservar nuevamente después del ${hasta}.`
                : 'Tenés una suspensión activa por cancelaciones tardías y no podés crear reservas en este momento.',
              suspendido: true,
              suspendido_hasta: susp.suspendido_hasta ?? null,
            });
          }
        } catch (suspErr) {
          console.warn('⚠️ verificación suspensión reserva:', suspErr.message);
        }
      }

      const canchaStorage = resolveReservaCanchaStorageText(req.body);
      const partidoCanchaNombre = resolvePartidoCanchaNombre(req.body);
      const durationMinutes = parsePositiveInt(duracion_minutos) ?? 90;

      const blocked = await isCourtBlocked(supabaseAdmin, {
        sedeNombre,
        sedeId,
        fecha,
        hora,
        cancha: canchaStorage,
        duracionMinutos: durationMinutes,
      });

      if (blocked) {
        return res.status(409).json({ error: 'Este horario ya está reservado' });
      }

      const insertRow = buildReservaInsertRow({
        sedeNombre,
        sedeId,
        fecha,
        hora,
        hora_inicio: req.body.hora_inicio,
        hora_fin: req.body.hora_fin,
        canchaText: canchaStorage,
        cancha_id: cancha_id ?? req.body.cancha_id,
        nombre: contactNombre,
        email: contactEmail,
        telefono: contactWhatsapp,
        whatsapp: contactWhatsapp,
        nivel: nivel_partido ?? nivel ?? 'Principiante',
        precio,
        estado: modoPartido ? 'prereserva' : 'pendiente',
        pago_estado: 'pendiente',
        duracion_minutos: durationMinutes,
        user_id: authUser.id,
      });

      console.log('[POST reserva] insert', {
        sede_id: sedeId,
        fecha,
        estado: modoPartido ? 'prereserva' : 'pendiente',
      });

      const { data: reservaRows, error: insertErr } = await supabaseAdmin
        .from('reservas')
        .insert([insertRow])
        .select(RESERVA_OWNER_SELECT);

      if (insertErr) {
        const classified = classifyReservaWriteError(insertErr);
        if (classified) {
          return res.status(classified.status).json({ error: classified.error });
        }
        throw insertErr;
      }

      const reserva = reservaRows?.[0];
      if (!reserva) {
        throw new Error('No se pudo crear la reserva');
      }

      console.log(`✓ Reserva creada id=${reserva.id}`);

      let partidoId = null;
      let deadlineCancel = null;
      if (modoPartido) {
        if (sedeId == null) {
          return res.status(400).json({ error: 'sede_id requerido para partido abierto' });
        }

        const nivelPartido = nivel_partido ?? nivel ?? 'Intermedio';
        deadlineCancel = computePartidoDeadlineCancel(fecha, hora);

        const partidoInsert = buildPartidoAbiertoInsertRow({
          sedeRow: { id: sedeId, nombre: sedeNombre },
          body: req.body,
          reservaId: reserva.id,
          canchaNombre: partidoCanchaNombre,
          capitanFields: await buildCapitanFields(supabaseAdmin, authUser, { email: contactEmail }),
          fecha,
          hora,
          nivel: nivelPartido,
          estado: 'abierto',
          deadlineCancel,
          duracionMinutos: durationMinutes,
        });
        console.log('[DEBUG partidos_abiertos INSERT]', {
          reserva_id: reserva.id,
          sede_id: sedeId,
          estado: 'abierto',
        });

        const { data: partido, error: partidoErr } = await supabaseAdmin
          .from('partidos_abiertos')
          .insert([partidoInsert])
          .select('*')
          .single();

        if (partidoErr) throw partidoErr;

        const { error: hostJoinErr } = await supabaseAdmin
          .from('partidos_abiertos_jugadores')
          .insert([{
            partido_id: partido.id,
            user_id: authUser.id,
            email: authUser.email ?? contactEmail,
          }]);

        if (hostJoinErr) throw hostJoinErr;

        partidoId = partido.id;
        console.log(`✓ Partido prereserva ${partidoId} creado (sin pago) — reserva ${reserva.id}`);
      }

      const mappedReserva = mapMisReservaRow({ ...reserva, sedes: { nombre: sedeNombre } });

      if (modoPartido && partidoId) {
        return res.status(201).json({
          partido_id: partidoId,
          partido_link: `padbolmatch://partido/${partidoId}`,
          deadline_cancel: deadlineCancel,
          reserva_id: reserva.id,
        });
      }

      // Mismo shape histórico (array con 1 reserva); 201 al crear.
      return res.status(201).json([mappedReserva]);
    } catch (err) {
      const classified = classifyReservaWriteError(err);
      if (classified) {
        return res.status(classified.status).json({ error: classified.error });
      }
      console.error('❌ Error POST reserva:', err.message);
      sendHttpError(res, err);
    }
  };
}
