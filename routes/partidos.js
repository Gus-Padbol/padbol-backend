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

const PARTIDO_SELECT = `
  id,
  sede_id,
  host_user_id,
  host_email,
  fecha,
  hora,
  nivel,
  estado,
  max_jugadores,
  ganador,
  resultado,
  created_at,
  sedes ( nombre ),
  partidos_abiertos_jugadores ( user_id, email, joined_at )
`;

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

  return {
    id: partido.id,
    sede_id: partido.sede_id,
    sede_nombre: partido.sedes?.nombre ?? null,
    fecha: partido.fecha,
    hora: formatHora(partido.hora),
    nivel: partido.nivel,
    estado: partido.estado ?? 'abierto',
    jugadores_actuales: jugadoresRows.length,
    jugadores_count: jugadoresRows.length,
    max_jugadores: partido.max_jugadores ?? 4,
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

export function createPartidosRouter({ supabase, supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/abiertos', async (req, res) => {
    try {
      const today = getTodayArgentinaDate();
      const auth = await getAuthenticatedUser(req);
      const user = auth.user ?? null;

      const { data: partidos, error } = await supabaseAdmin
        .from('partidos_abiertos')
        .select(PARTIDO_SELECT)
        .eq('estado', 'abierto')
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
      if (partido.estado !== 'abierto') {
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
      if (newCount >= maxJugadores) {
        await supabaseAdmin
          .from('partidos_abiertos')
          .update({ estado: 'completo' })
          .eq('id', partidoId);
      }

      console.log(`✓ POST /api/partidos/${partidoId}/unirse — ${user.email ?? user.id}`);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/unirse:', err.message);
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
