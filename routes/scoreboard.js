import {
  registrarPunto,
  deshacerPunto,
  cambiarSaque,
  iniciarTiebreak,
  resetPartidoCompleto,
  enrichPartidoResponse,
  resolveJerseyNumber,
  pauseCronometro,
  startCronometro,
} from '../utils/scoreboardLogic.js';

async function resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails }) {
  const email = String(user.email || '').trim().toLowerCase();
  const row = await fetchUserRoleRowForAuthUser(user);
  if (!row && legacySuperAdminEmails.includes(email)) {
    return { rol: 'super_admin', sede_id: null };
  }
  const sedeIdRaw = row?.sede_id;
  const sedeIdNum = sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;
  return {
    rol: String(row?.role || '').trim().toLowerCase() || null,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
  };
}

function assertCanControlScoreboard(role, sedeId) {
  if (role.rol === 'super_admin') return;
  if (role.rol === 'admin_club' && role.sede_id != null && Number(role.sede_id) === Number(sedeId)) {
    return;
  }
  if (role.rol === 'admin_sede' && role.sede_id != null && Number(role.sede_id) === Number(sedeId)) {
    return;
  }
  const err = new Error('No tenés permiso para controlar este scoreboard');
  err.status = 403;
  throw err;
}

function parseSedeId(raw) {
  const sid = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function emitScoreboardUpdate(io, partidoId, partido) {
  if (!io) return;
  const payload = enrichPartidoResponse(partido);
  io.to(`scoreboard:${partidoId}`).emit('scoreboard:update', payload);
}

async function fetchPartido(supabaseAdmin, partidoId) {
  const { data, error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select('*')
    .eq('id', partidoId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    const err = new Error('Partido no encontrado');
    err.status = 404;
    throw err;
  }
  return data;
}

async function savePartido(supabaseAdmin, partido) {
  const { id, ...rest } = partido;
  const { data, error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .update({ ...rest, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export function mountScoreboardRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
  io = null,
}) {
  app.post('/api/scoreboard/partidos', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const {
        sede_id,
        torneo_id = null,
        torneo_nombre = null,
        cancha = null,
        equipo_a_nombre,
        equipo_b_nombre,
        equipo_a_jugadores = [],
        equipo_b_jugadores = [],
        saque_actual = 'A',
        color_a = '#1a3a6e',
        color_b = '#6e1a1a',
        jersey_a1,
        jersey_a2,
        jersey_a3,
        jersey_a4,
        jersey_b1,
        jersey_b2,
        jersey_b3,
        jersey_b4,
      } = req.body || {};

      const sid = parseSedeId(sede_id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });
      if (!equipo_a_nombre || !equipo_b_nombre) {
        return res.status(400).json({ error: 'equipo_a_nombre y equipo_b_nombre son requeridos' });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanControlScoreboard(role, sid);

      const jugadoresA = Array.isArray(equipo_a_jugadores) ? equipo_a_jugadores : [];
      const jugadoresB = Array.isArray(equipo_b_jugadores) ? equipo_b_jugadores : [];
      const resolvedJerseysA = [1, 2, 3, 4].map((slot, idx) => resolveJerseyNumber(
        [jersey_a1, jersey_a2, jersey_a3, jersey_a4][idx] ?? jugadoresA[idx]?.jersey ?? jugadoresA[idx]?.numero,
        slot,
      ));
      const resolvedJerseysB = [1, 2, 3, 4].map((slot, idx) => resolveJerseyNumber(
        [jersey_b1, jersey_b2, jersey_b3, jersey_b4][idx] ?? jugadoresB[idx]?.jersey ?? jugadoresB[idx]?.numero,
        slot,
      ));

      const row = {
        sede_id: sid,
        torneo_id: torneo_id || null,
        torneo_nombre: torneo_nombre ? String(torneo_nombre).trim() : null,
        cancha,
        equipo_a_nombre: String(equipo_a_nombre).trim(),
        equipo_b_nombre: String(equipo_b_nombre).trim(),
        equipo_a_jugadores: jugadoresA.map((j, idx) => ({
          ...j,
          numero: resolvedJerseysA[idx],
          jersey: resolvedJerseysA[idx],
          nombre: String(j?.nombre ?? j?.name ?? `Jugador ${idx + 1}`).trim() || `Jugador ${idx + 1}`,
        })),
        equipo_b_jugadores: jugadoresB.map((j, idx) => ({
          ...j,
          numero: resolvedJerseysB[idx],
          jersey: resolvedJerseysB[idx],
          nombre: String(j?.nombre ?? j?.name ?? `Jugador ${idx + 1}`).trim() || `Jugador ${idx + 1}`,
        })),
        jersey_a1: resolvedJerseysA[0],
        jersey_a2: resolvedJerseysA[1],
        jersey_a3: resolvedJerseysA[2],
        jersey_a4: resolvedJerseysA[3],
        jersey_b1: resolvedJerseysB[0],
        jersey_b2: resolvedJerseysB[1],
        jersey_b3: resolvedJerseysB[2],
        jersey_b4: resolvedJerseysB[3],
        saque_actual: saque_actual === 'B' ? 'B' : 'A',
        color_a: String(color_a || '#1a3a6e').trim(),
        color_b: String(color_b || '#6e1a1a').trim(),
        estado: 'pendiente',
      };

      const { data, error } = await supabaseAdmin
        .from('scoreboard_partidos')
        .insert(row)
        .select('*')
        .single();

      if (error) throw error;

      const enriched = enrichPartidoResponse(data);
      emitScoreboardUpdate(io, data.id, data);
      return res.status(201).json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/partidos:', err.message);
      return res.status(st).json({ error: err.message || 'Error al crear partido' });
    }
  });

  app.get('/api/scoreboard/partidos/:id', async (req, res) => {
    try {
      const partido = await fetchPartido(supabaseAdmin, req.params.id);
      return res.json(enrichPartidoResponse(partido));
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/scoreboard/partidos/:id:', err.message);
      return res.status(st).json({ error: err.message || 'Error al obtener partido' });
    }
  });

  app.get('/api/scoreboard/cancha/:sedeId/:cancha', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.sedeId);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const cancha = decodeURIComponent(String(req.params.cancha || '').trim());
      if (!cancha) return res.status(400).json({ error: 'cancha inválida' });

      const { data, error } = await supabaseAdmin
        .from('scoreboard_partidos')
        .select('*')
        .eq('sede_id', sid)
        .eq('cancha', cancha)
        .in('estado', ['en_curso', 'pendiente'])
        .order('updated_at', { ascending: false })
        .limit(1);

      if (error) throw error;

      const partido = data?.[0] ?? null;
      return res.json(partido ? enrichPartidoResponse(partido) : null);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/scoreboard/cancha/:sedeId/:cancha:', err.message);
      return res.status(st).json({ error: err.message || 'Error al obtener partido por cancha' });
    }
  });

  app.post('/api/scoreboard/partidos/:id/punto/:equipo', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const equipo = String(req.params.equipo || '').toUpperCase();
      if (!['A', 'B'].includes(equipo)) {
        return res.status(400).json({ error: 'Equipo debe ser A o B' });
      }

      let partido = await fetchPartido(supabaseAdmin, req.params.id);
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanControlScoreboard(role, partido.sede_id);

      registrarPunto(partido, equipo);
      partido = await savePartido(supabaseAdmin, partido);

      const enriched = enrichPartidoResponse(partido);
      emitScoreboardUpdate(io, partido.id, partido);
      return res.json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/partidos/:id/punto/:equipo:', err.message);
      return res.status(st).json({ error: err.message || 'Error al registrar punto' });
    }
  });

  app.post('/api/scoreboard/partidos/:id/deshacer', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      let partido = await fetchPartido(supabaseAdmin, req.params.id);
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanControlScoreboard(role, partido.sede_id);

      deshacerPunto(partido);
      partido = await savePartido(supabaseAdmin, partido);

      const enriched = enrichPartidoResponse(partido);
      emitScoreboardUpdate(io, partido.id, partido);
      return res.json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/partidos/:id/deshacer:', err.message);
      return res.status(st).json({ error: err.message || 'Error al deshacer punto' });
    }
  });

  app.post('/api/scoreboard/partidos/:id/saque', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      let partido = await fetchPartido(supabaseAdmin, req.params.id);
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanControlScoreboard(role, partido.sede_id);

      cambiarSaque(partido);
      partido = await savePartido(supabaseAdmin, partido);

      const enriched = enrichPartidoResponse(partido);
      emitScoreboardUpdate(io, partido.id, partido);
      return res.json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/partidos/:id/saque:', err.message);
      return res.status(st).json({ error: err.message || 'Error al cambiar saque' });
    }
  });

  app.post('/api/scoreboard/partidos/:id/tiebreak', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      let partido = await fetchPartido(supabaseAdmin, req.params.id);
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanControlScoreboard(role, partido.sede_id);

      iniciarTiebreak(partido);
      partido = await savePartido(supabaseAdmin, partido);

      const enriched = enrichPartidoResponse(partido);
      emitScoreboardUpdate(io, partido.id, partido);
      return res.json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/partidos/:id/tiebreak:', err.message);
      return res.status(st).json({ error: err.message || 'Error al iniciar tie-break' });
    }
  });

  app.post('/api/scoreboard/partidos/:id/cronometro/:accion', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const accion = String(req.params.accion || '').toLowerCase();
      if (!['start', 'pause', 'reset'].includes(accion)) {
        return res.status(400).json({ error: 'Acción inválida. Usar start, pause o reset' });
      }

      let partido = await fetchPartido(supabaseAdmin, req.params.id);
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanControlScoreboard(role, partido.sede_id);

      if (accion === 'start') {
        startCronometro(partido);
      } else if (accion === 'pause') {
        pauseCronometro(partido);
      } else if (accion === 'reset') {
        resetPartidoCompleto(partido);
      }

      partido = await savePartido(supabaseAdmin, partido);
      const enriched = enrichPartidoResponse(partido);
      emitScoreboardUpdate(io, partido.id, partido);
      return res.json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/partidos/:id/cronometro/:accion:', err.message);
      return res.status(st).json({ error: err.message || 'Error en cronómetro' });
    }
  });

  app.get('/api/scoreboard/sponsors/:sedeId', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.sedeId);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const { data, error } = await supabaseAdmin
        .from('scoreboard_sponsors')
        .select('id, nombre, categoria, logo_url, orden')
        .eq('sede_id', sid)
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (error) throw error;
      return res.json({ sponsors: data || [] });
    } catch (err) {
      console.error('❌ GET /api/scoreboard/sponsors/:sedeId:', err.message);
      return res.status(500).json({ error: err.message || 'Error al obtener sponsors' });
    }
  });
}

export function initScoreboardSocket(io) {
  io.on('connection', (socket) => {
    socket.on('scoreboard:join', ({ partidoId }) => {
      if (!partidoId) return;
      socket.join(`scoreboard:${partidoId}`);
    });

    socket.on('scoreboard:leave', ({ partidoId }) => {
      if (!partidoId) return;
      socket.leave(`scoreboard:${partidoId}`);
    });
  });
}
