import express from 'express';

function getTodayArgentinaDate() {
  const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const year = nowAR.getFullYear();
  const month = String(nowAR.getMonth() + 1).padStart(2, '0');
  const day = String(nowAR.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatHora(hora) {
  if (!hora) return null;
  return String(hora).slice(0, 5);
}

function parsePartidoId(id) {
  const partidoId = parseInt(id, 10);
  if (Number.isNaN(partidoId)) return null;
  return partidoId;
}

function isMatchPast(fecha, hora) {
  if (!fecha) return false;
  const time = hora ? String(hora).slice(0, 5) : '23:59';
  const matchDate = new Date(`${fecha}T${time}:00`);
  return !Number.isNaN(matchDate.getTime()) && matchDate.getTime() <= Date.now();
}

const OPEN_JOIN_STATES = ['esperando_jugadores', 'abierto'];

const PARTIDO_SELECT = `
  id,
  sede_id,
  reserva_id,
  cancha_id,
  host_user_id,
  host_email,
  fecha,
  hora,
  nivel,
  estado,
  max_jugadores,
  jugadores_actuales,
  jugadores_necesarios,
  deadline_cancel,
  pago_url,
  ganador,
  resultado,
  created_at,
  sedes ( nombre ),
  partidos_abiertos_jugadores ( user_id, email, joined_at )
`;

function computeDeadlineCancel(fecha, hora) {
  const time = hora ? String(hora).slice(0, 5) : '00:00';
  const matchDate = new Date(`${fecha}T${time}:00-03:00`);
  if (Number.isNaN(matchDate.getTime())) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(matchDate.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

async function cancelPartidoWithReserva(supabaseAdmin, partidoId, reservaId, partidoEstado) {
  if (reservaId) {
    await supabaseAdmin
      .from('reservas')
      .update({ estado: 'cancelada', pago_estado: 'no_aplica' })
      .eq('id', reservaId);
  }

  await supabaseAdmin
    .from('partidos_abiertos')
    .update({ estado: partidoEstado })
    .eq('id', partidoId);
}

async function isCourtBlocked(supabaseAdmin, { sedeId, sedeNombre, fecha, hora, cancha }) {
  let query = supabaseAdmin
    .from('reservas')
    .select('id')
    .eq('fecha', fecha)
    .eq('hora', hora)
    .eq('cancha', cancha)
    .in('estado', ['prereserva', 'confirmada', 'reservada', 'pendiente']);

  if (sedeId) {
    query = query.eq('sede_id', sedeId);
  } else if (sedeNombre) {
    query = query.eq('sede', sedeNombre);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function cancelExpiredPartidos(supabaseAdmin) {
  const now = new Date().toISOString();
  const { data: partidos, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, reserva_id, jugadores_actuales, jugadores_necesarios, max_jugadores')
    .eq('estado', 'esperando_jugadores')
    .lte('deadline_cancel', now);

  if (error) throw error;
  if (!partidos?.length) return 0;

  let cancelled = 0;
  for (const partido of partidos) {
    const needed = partido.jugadores_necesarios ?? partido.max_jugadores ?? 4;
    const current = partido.jugadores_actuales ?? 0;
    if (current >= needed) continue;

    await cancelPartidoWithReserva(
      supabaseAdmin,
      partido.id,
      partido.reserva_id,
      'cancelado_por_tiempo',
    );
    cancelled += 1;
    console.log(`✓ Partido ${partido.id} cancelado por deadline`);
  }

  return cancelled;
}

async function resolveHostName(partido, supabaseAdmin) {
  const filters = [];
  if (partido.host_user_id) {
    filters.push(`supabase_user_id.eq.${partido.host_user_id}`);
  }
  if (partido.host_email) {
    filters.push(`email.eq."${String(partido.host_email).replace(/"/g, '\\"')}"`);
  }

  if (filters.length > 0) {
    const { data: perfil } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('nombre, email')
      .or(filters.join(','))
      .maybeSingle();

    if (perfil?.nombre) return perfil.nombre;
    if (perfil?.email) return perfil.email;
  }

  return partido.host_email ?? 'Anfitrión';
}

async function resolveJugadorName({ user_id: userId, email }, supabaseAdmin) {
  const filters = [];
  if (userId) filters.push(`supabase_user_id.eq.${userId}`);
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);

  if (filters.length > 0) {
    const { data: perfil } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('nombre, email')
      .or(filters.join(','))
      .maybeSingle();

    if (perfil?.nombre) return perfil.nombre;
    if (perfil?.email) return perfil.email;
  }

  return email ?? 'Jugador';
}

async function userCanAccessPartido(partidoId, user, supabaseAdmin) {
  const { data: partido, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, host_user_id, estado, fecha, hora')
    .eq('id', partidoId)
    .maybeSingle();

  if (error) throw error;
  if (!partido) return { allowed: false, status: 404, reason: 'Partido no encontrado' };
  if (partido.host_user_id === user.id) return { allowed: true, partido };

  const { data: joinRow, error: joinErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('id')
    .eq('partido_id', partidoId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (joinErr) throw joinErr;
  if (!joinRow) {
    return { allowed: false, status: 403, reason: 'No tenés permiso para modificar este partido' };
  }

  return { allowed: true, partido };
}

async function mapPartidoRow(partido, supabaseAdmin, user = null) {
  const hostNombre = await resolveHostName(partido, supabaseAdmin);
  const jugadoresRows = [...(partido.partidos_abiertos_jugadores ?? [])]
    .sort((a, b) => new Date(a.joined_at ?? 0) - new Date(b.joined_at ?? 0));
  const participantUserIds = jugadoresRows.map((row) => row.user_id).filter(Boolean);
  const jugadoresActuales = partido.jugadores_actuales ?? jugadoresRows.length;
  const maxJugadores = partido.max_jugadores ?? partido.jugadores_necesarios ?? 4;

  return {
    id: partido.id,
    sede_id: partido.sede_id,
    reserva_id: partido.reserva_id ?? null,
    cancha_id: partido.cancha_id ?? null,
    sede_nombre: partido.sedes?.nombre ?? null,
    fecha: partido.fecha,
    hora: formatHora(partido.hora),
    nivel: partido.nivel,
    estado: partido.estado ?? 'abierto',
    jugadores_actuales: jugadoresActuales,
    jugadores_count: jugadoresActuales,
    jugadores_necesarios: partido.jugadores_necesarios ?? maxJugadores,
    max_jugadores: maxJugadores,
    lugares_disponibles: Math.max(0, maxJugadores - jugadoresActuales),
    deadline_cancel: partido.deadline_cancel ?? null,
    pago_url: partido.pago_url ?? null,
    host_nombre: hostNombre,
    host_email: partido.host_email ?? null,
    host_user_id: partido.host_user_id ?? null,
    participant_user_ids: participantUserIds,
    es_anfitrion: user ? partido.host_user_id === user.id : false,
    soy_participante: user
      ? participantUserIds.includes(user.id) || partido.host_user_id === user.id
      : false,
    ganador: partido.ganador ?? null,
    resultado: partido.resultado ?? null,
    created_at: partido.created_at,
  };
}

async function mapPartidoDetail(partido, supabaseAdmin, user) {
  const base = await mapPartidoRow(partido, supabaseAdmin, user);
  const jugadoresRows = [...(partido.partidos_abiertos_jugadores ?? [])]
    .sort((a, b) => new Date(a.joined_at ?? 0) - new Date(b.joined_at ?? 0));

  const jugadores = await Promise.all(
    jugadoresRows.map(async (row) => ({
      user_id: row.user_id,
      email: row.email ?? null,
      nombre: await resolveJugadorName(row, supabaseAdmin),
    })),
  );

  const midpoint = Math.ceil(jugadores.length / 2);

  return {
    ...base,
    jugadores,
    equipo1: jugadores.slice(0, midpoint),
    equipo2: jugadores.slice(midpoint),
  };
}

function validateResultadoPayload(body) {
  const equipo1Sets = Number(body?.equipo1_sets);
  const equipo2Sets = Number(body?.equipo2_sets);
  const setsDetalle = Array.isArray(body?.sets_detalle) ? body.sets_detalle : [];

  if (!Number.isFinite(equipo1Sets) || !Number.isFinite(equipo2Sets)) {
    return { valid: false, error: 'equipo1_sets y equipo2_sets son requeridos' };
  }

  if (equipo1Sets < 0 || equipo2Sets < 0 || equipo1Sets > 3 || equipo2Sets > 3) {
    return { valid: false, error: 'Los sets ganados deben estar entre 0 y 3' };
  }

  if (equipo1Sets === equipo2Sets) {
    return { valid: false, error: 'Debe haber un ganador' };
  }

  const normalizedSets = setsDetalle
    .slice(0, 3)
    .map((set) => ({
      eq1: Number(set?.eq1),
      eq2: Number(set?.eq2),
    }))
    .filter((set) => Number.isFinite(set.eq1) && Number.isFinite(set.eq2));

  if (normalizedSets.length === 0) {
    return { valid: false, error: 'Ingresá al menos un set con puntaje' };
  }

  let countedEq1 = 0;
  let countedEq2 = 0;

  normalizedSets.forEach((set) => {
    if (set.eq1 > set.eq2) countedEq1 += 1;
    if (set.eq2 > set.eq1) countedEq2 += 1;
  });

  if (countedEq1 !== equipo1Sets || countedEq2 !== equipo2Sets) {
    return { valid: false, error: 'Los sets ganados no coinciden con los puntajes ingresados' };
  }

  const ganador = equipo1Sets > equipo2Sets ? 'equipo1' : 'equipo2';

  return {
    valid: true,
    ganador,
    resultado: {
      equipo1_sets: equipo1Sets,
      equipo2_sets: equipo2Sets,
      sets_detalle: normalizedSets,
    },
  };
}

export function createPartidosRouter({
  supabase,
  supabaseAdmin,
  getAuthenticatedUser,
  computePartidoDeadlineCancel,
  triggerPartidoCreatorPayment,
}) {
  const resolveDeadline = computePartidoDeadlineCancel ?? computeDeadlineCancel;

  const router = express.Router();

  router.post('/crear-con-prereserva', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const {
        sede_id,
        cancha_id,
        cancha,
        fecha,
        hora,
        duracion,
        duracion_minutos,
        nivel,
        precio,
        precio_base,
        platform_fee,
        nombre,
        email,
        whatsapp,
      } = req.body;

      const sedeId = parseInt(sede_id, 10);
      const canchaNum = parseInt(cancha_id ?? cancha, 10);
      const durationMinutes = parseInt(duracion_minutos ?? duracion, 10);

      if (!sedeId || !fecha || !hora || !nivel || Number.isNaN(canchaNum)) {
        return res.status(400).json({ error: 'Faltan campos: sede_id, cancha_id, fecha, hora, nivel' });
      }

      const { data: sedeRow, error: sedeErr } = await supabaseAdmin
        .from('sedes')
        .select('id, nombre')
        .eq('id', sedeId)
        .maybeSingle();

      if (sedeErr) throw sedeErr;
      if (!sedeRow) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const blocked = await isCourtBlocked(supabaseAdmin, {
        sedeId,
        sedeNombre: sedeRow.nombre,
        fecha,
        hora,
        cancha: canchaNum,
      });

      if (blocked) {
        return res.status(409).json({ error: 'Este horario ya está reservado' });
      }

      const metadata = user.user_metadata ?? {};
      const contactNombre = nombre
        ?? metadata.full_name
        ?? metadata.name
        ?? user.email
        ?? 'Jugador';
      const contactEmail = email ?? user.email;
      const contactWhatsapp = whatsapp
        ?? metadata.phone
        ?? metadata.whatsapp
        ?? metadata.telefono
        ?? '';
      const totalPrecio = precio != null ? parseInt(precio, 10) : 0;
      const deadlineCancel = resolveDeadline(fecha, hora);

      const { data: reservaRows, error: reservaErr } = await supabaseAdmin
        .from('reservas')
        .insert([{
          sede: sedeRow.nombre,
          sede_id: sedeId,
          fecha,
          hora,
          cancha: canchaNum,
          nombre: contactNombre,
          email: contactEmail,
          telefono: contactWhatsapp,
          whatsapp: contactWhatsapp,
          nivel,
          precio: totalPrecio,
          monto: totalPrecio,
          estado: 'prereserva',
          pago_estado: 'pendiente',
          duracion_minutos: Number.isNaN(durationMinutes) ? null : durationMinutes,
          user_id: user.id,
        }])
        .select('*');

      if (reservaErr) throw reservaErr;

      const reserva = reservaRows?.[0];
      if (!reserva) {
        throw new Error('No se pudo crear la prereserva');
      }

      const { data: partido, error: partidoErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .insert([{
          reserva_id: reserva.id,
          sede_id: sedeId,
          cancha_id: canchaNum,
          host_user_id: user.id,
          host_email: contactEmail,
          fecha,
          hora,
          nivel,
          estado: 'esperando_jugadores',
          jugadores_actuales: 1,
          jugadores_necesarios: 4,
          max_jugadores: 4,
          deadline_cancel: deadlineCancel,
        }])
        .select('*')
        .single();

      if (partidoErr) throw partidoErr;

      const { error: hostJoinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .insert([{
          partido_id: partido.id,
          user_id: user.id,
          email: contactEmail,
        }]);

      if (hostJoinErr) throw hostJoinErr;

      console.log(`✓ POST /api/partidos/crear-con-prereserva — partido ${partido.id}, reserva ${reserva.id}`);
      res.status(201).json({
        partido_id: partido.id,
        reserva_id: reserva.id,
        deadline_cancel: deadlineCancel,
        partido_link: `padbolmatch://partido/${partido.id}`,
        sede_nombre: sedeRow.nombre,
        fecha,
        hora: formatHora(hora),
        nivel,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/crear-con-prereserva:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/abiertos', async (req, res) => {
    try {
      const today = getTodayArgentinaDate();
      const auth = await getAuthenticatedUser(req);
      const user = auth.user ?? null;

      const { data: partidos, error } = await supabaseAdmin
        .from('partidos_abiertos')
        .select(PARTIDO_SELECT)
        .in('estado', OPEN_JOIN_STATES)
        .gte('fecha', today)
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true });

      if (error) throw error;

      let merged = partidos || [];

      if (user) {
        const { data: completos, error: completosErr } = await supabaseAdmin
          .from('partidos_abiertos')
          .select(PARTIDO_SELECT)
          .eq('estado', 'completo');

        if (completosErr) throw completosErr;

        const userCompletos = (completos || []).filter((partido) => {
          const participantIds = (partido.partidos_abiertos_jugadores ?? [])
            .map((row) => row.user_id);
          const isMember = partido.host_user_id === user.id || participantIds.includes(user.id);
          return isMember && isMatchPast(partido.fecha, partido.hora);
        });

        const byId = new Map(merged.map((partido) => [partido.id, partido]));
        userCompletos.forEach((partido) => {
          if (!byId.has(partido.id)) byId.set(partido.id, partido);
        });
        merged = [...byId.values()];
      }

      const result = await Promise.all(
        merged.map((partido) => mapPartidoRow(partido, supabaseAdmin, user)),
      );

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/partidos/abiertos:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/unirse', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (partido.estado !== 'abierto' && partido.estado !== 'esperando_jugadores') {
        return res.status(400).json({ error: 'Este partido ya no acepta jugadores' });
      }

      const { data: existingJoin, error: existingErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('id')
        .eq('partido_id', partidoId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingErr) throw existingErr;
      if (existingJoin) {
        return res.status(409).json({ error: 'Ya estás unido a este partido' });
      }

      const { count, error: countErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('*', { count: 'exact', head: true })
        .eq('partido_id', partidoId);

      if (countErr) throw countErr;

      const maxJugadores = partido.max_jugadores ?? 4;
      if ((count ?? 0) >= maxJugadores) {
        return res.status(409).json({ error: 'El partido ya está completo' });
      }

      const { error: insertErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .insert([{
          partido_id: partidoId,
          user_id: user.id,
          email: user.email ?? null,
        }]);

      if (insertErr) throw insertErr;

      const newCount = (count ?? 0) + 1;
      await supabaseAdmin
        .from('partidos_abiertos')
        .update({ jugadores_actuales: newCount })
        .eq('id', partidoId);

      let partidoCompleto = false;
      let requierePagoCreador = false;
      let pagoUrl = null;

      if (newCount >= maxJugadores) {
        partidoCompleto = true;
        await supabaseAdmin
          .from('partidos_abiertos')
          .update({ estado: 'completo', jugadores_actuales: newCount })
          .eq('id', partidoId);

        let reservaId = partido.reserva_id;
        if (!reservaId && partido.host_user_id) {
          const { data: linkedReserva } = await supabaseAdmin
            .from('reservas')
            .select('*')
            .eq('user_id', partido.host_user_id)
            .eq('fecha', partido.fecha)
            .eq('hora', partido.hora)
            .in('estado', ['prereserva', 'confirmada'])
            .maybeSingle();
          if (linkedReserva) {
            reservaId = linkedReserva.id;
            await supabaseAdmin
              .from('partidos_abiertos')
              .update({ reserva_id: reservaId })
              .eq('id', partidoId);
          }
        }

        if (reservaId && triggerPartidoCreatorPayment) {
          const { data: reserva, error: reservaErr } = await supabaseAdmin
            .from('reservas')
            .select('*')
            .eq('id', reservaId)
            .maybeSingle();

          if (!reservaErr && reserva) {
            try {
              const payment = await triggerPartidoCreatorPayment({
                reserva,
                partido: { ...partido, id: partidoId },
                sedeId: partido.sede_id,
              });
              requierePagoCreador = true;
              pagoUrl = payment.init_point ?? null;
              console.log(`✓ Partido ${partidoId} completo — MP preference para creador ${partido.host_user_id}`);
            } catch (paymentErr) {
              console.warn(`⚠️ Pago creador partido ${partidoId}:`, paymentErr.message);
            }
          }
        }
      }

      const hostNombre = await resolveHostName(partido, supabaseAdmin);

      console.log(`✓ POST /api/partidos/${partidoId}/unirse — ${user.email ?? user.id}`);
      res.json({
        success: true,
        partido_completo: partidoCompleto,
        requiere_pago_creador: requierePagoCreador,
        pago_url: pagoUrl,
        host_nombre: hostNombre,
        jugadores_actuales: newCount,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/unirse:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/cancelar', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      if (partido.host_user_id !== user.id) {
        return res.status(403).json({ error: 'Solo el creador puede cancelar el partido' });
      }

      if (!['esperando_jugadores', 'abierto'].includes(partido.estado)) {
        return res.status(400).json({ error: 'Este partido ya no se puede cancelar' });
      }

      await cancelPartidoWithReserva(
        supabaseAdmin,
        partidoId,
        partido.reserva_id,
        'cancelado',
      );

      console.log(`✓ POST /api/partidos/${partidoId}/cancelar — ${user.email ?? user.id}`);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/cancelar:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/iniciar-pago', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('*')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      if (partido.host_user_id !== user.id) {
        return res.status(403).json({ error: 'Solo el creador puede pagar la reserva' });
      }

      if (partido.estado !== 'completo') {
        return res.status(400).json({ error: 'El partido aún no está completo' });
      }

      if (partido.pago_url) {
        return res.json({ init_point: partido.pago_url, payment_url: partido.pago_url });
      }

      if (!partido.reserva_id || !triggerPartidoCreatorPayment) {
        return res.status(400).json({ error: 'No hay reserva vinculada para cobrar' });
      }

      const { data: reserva, error: reservaErr } = await supabaseAdmin
        .from('reservas')
        .select('*')
        .eq('id', partido.reserva_id)
        .maybeSingle();

      if (reservaErr) throw reservaErr;
      if (!reserva) {
        return res.status(404).json({ error: 'Reserva no encontrada' });
      }

      const payment = await triggerPartidoCreatorPayment({
        reserva,
        partido,
        sedeId: partido.sede_id,
      });

      res.json({
        init_point: payment.init_point,
        payment_url: payment.init_point,
        preference_id: payment.preference_id,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/iniciar-pago:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { torneo_id, equipo_a_id, equipo_b_id, fecha_hora, cancha_id, sede_id, fecha, hora, nivel } = req.body;

      if (torneo_id) {
        const { data, error } = await supabase
          .from('partidos')
          .insert([{
            torneo_id,
            equipo_a_id,
            equipo_b_id,
            fecha_hora,
            cancha_id,
            sede_id,
            estado: 'pendiente',
          }])
          .select();

        if (error) throw error;
        return res.json(data);
      }

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      if (!sede_id || !fecha || !hora || !nivel) {
        return res.status(400).json({ error: 'Faltan campos: sede_id, fecha, hora, nivel' });
      }

      const { data: partido, error: insertErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .insert([{
          sede_id: parseInt(sede_id, 10),
          host_user_id: user.id,
          host_email: user.email ?? null,
          fecha,
          hora,
          nivel,
          estado: 'abierto',
          max_jugadores: 4,
        }])
        .select('*')
        .single();

      if (insertErr) throw insertErr;

      const { error: hostJoinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .insert([{
          partido_id: partido.id,
          user_id: user.id,
          email: user.email ?? null,
        }]);

      if (hostJoinErr) throw hostJoinErr;

      const hostNombre = await resolveHostName(partido, supabaseAdmin);

      console.log(`✓ POST /api/partidos — partido abierto ${partido.id} por ${user.email ?? user.id}`);
      res.status(201).json({
        ...partido,
        hora: formatHora(partido.hora),
        sede_nombre: null,
        host_nombre: hostNombre,
        jugadores_actuales: 1,
        jugadores_count: 1,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export function createPartidosAbiertosRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/:id', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const access = await userCanAccessPartido(partidoId, user, supabaseAdmin);
      if (!access.allowed) {
        return res.status(access.status ?? 403).json({ error: access.reason });
      }

      const { data: partido, error } = await supabaseAdmin
        .from('partidos_abiertos')
        .select(PARTIDO_SELECT)
        .eq('id', partidoId)
        .maybeSingle();

      if (error) throw error;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }

      res.json(await mapPartidoDetail(partido, supabaseAdmin, user));
    } catch (err) {
      console.error('❌ Error GET /api/partidos-abiertos/:id:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/resultado', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const partidoId = parsePartidoId(req.params.id);
      if (partidoId == null) {
        return res.status(400).json({ error: 'ID de partido inválido' });
      }

      const access = await userCanAccessPartido(partidoId, user, supabaseAdmin);
      if (!access.allowed) {
        return res.status(access.status ?? 403).json({ error: access.reason });
      }

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, estado, fecha, hora')
        .eq('id', partidoId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (partido.estado !== 'completo') {
        return res.status(400).json({ error: 'Solo se puede cargar resultado en partidos completos' });
      }
      if (!isMatchPast(partido.fecha, partido.hora)) {
        return res.status(400).json({ error: 'El partido aún no finalizó' });
      }

      const validation = validateResultadoPayload(req.body);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const { error: updateErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .update({
          resultado: validation.resultado,
          ganador: validation.ganador,
          estado: 'finalizado',
        })
        .eq('id', partidoId);

      if (updateErr) throw updateErr;

      console.log(`✓ POST /api/partidos-abiertos/${partidoId}/resultado — ganador ${validation.ganador}`);
      res.json({ success: true, ganador: validation.ganador });
    } catch (err) {
      console.error('❌ Error POST /api/partidos-abiertos/:id/resultado:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createPartidosRouter;
