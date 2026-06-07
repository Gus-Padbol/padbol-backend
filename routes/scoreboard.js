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

const SCOREBOARD_PARTIDO_SELECT = [
  'id', 'sede_id', 'torneo_id', 'torneo_nombre', 'cancha',
  'equipo_a_nombre', 'equipo_b_nombre', 'equipo_a_jugadores', 'equipo_b_jugadores',
  'jersey_a1', 'jersey_a2', 'jersey_a3', 'jersey_a4',
  'jersey_b1', 'jersey_b2', 'jersey_b3', 'jersey_b4',
  'color_a', 'color_b',
  'color_uniforme_a1', 'color_uniforme_a2', 'color_uniforme_b1', 'color_uniforme_b2',
  'estado', 'saque_actual', 'score_a', 'score_b', 'games_a', 'games_b', 'sets_a', 'sets_b',
  'historial_sets', 'es_tiebreak', 'ultimo_punto', 'historial_puntos',
  'cronometro_inicio', 'cronometro_pausado', 'cronometro_segundos',
  'created_at', 'updated_at',
].join(', ');

const COLOR_UNIFORME_FIELDS = [
  'color_uniforme_a1',
  'color_uniforme_a2',
  'color_uniforme_b1',
  'color_uniforme_b2',
];

function parseColorUniforme(raw) {
  if (raw == null || raw === '') return null;
  return String(raw).trim().slice(0, 64);
}

function pickColorUniformes(body) {
  const out = {};
  for (const key of COLOR_UNIFORME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body ?? {}, key)) {
      out[key] = parseColorUniforme(body[key]);
    }
  }
  return out;
}

const JUGADOR_TEMP_SELECT = [
  'id', 'partido_id', 'equipo', 'slot', 'nombre', 'numero', 'foto_url', 'user_id',
  'created_at', 'updated_at',
].join(', ');

function parseEquipoQr(raw) {
  const eq = String(raw ?? '').trim().toLowerCase();
  if (eq !== 'a' && eq !== 'b') {
    throw Object.assign(new Error('equipo debe ser a o b'), { status: 400 });
  }
  return eq;
}

function parseSlotQr(raw) {
  const slot = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > 4) {
    throw Object.assign(new Error('slot debe ser un entero entre 1 y 4'), { status: 400 });
  }
  return slot;
}

function isPartidoActivo(estado) {
  return String(estado ?? '').toLowerCase() !== 'terminado';
}

async function fetchJugadoresTempByPartido(supabaseAdmin, partidoId) {
  const { data, error } = await supabaseAdmin
    .from('scoreboard_jugadores_temp')
    .select(JUGADOR_TEMP_SELECT)
    .eq('partido_id', partidoId)
    .order('equipo', { ascending: true })
    .order('slot', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

function emitScoreboardUpdate(io, partidoId, partido) {
  if (!io) return;
  const payload = enrichPartidoResponse(partido);
  io.to(`scoreboard:${partidoId}`).emit('scoreboard:update', payload);
}

async function fetchPartido(supabaseAdmin, partidoId) {
  const { data, error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select(SCOREBOARD_PARTIDO_SELECT)
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
    .select(SCOREBOARD_PARTIDO_SELECT)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) ? data[0] ?? null : data;
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
        ...pickColorUniformes(req.body),
        estado: 'pendiente',
      };

      const { data, error } = await supabaseAdmin
        .from('scoreboard_partidos')
        .insert(row)
        .select(SCOREBOARD_PARTIDO_SELECT)
        .limit(1);

      if (error) throw error;
      const created = Array.isArray(data) ? data[0] : data;
      if (!created) throw new Error('No se pudo crear el partido');

      const enriched = enrichPartidoResponse(created);
      emitScoreboardUpdate(io, created.id, created);
      return res.status(201).json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/partidos:', err.message);
      return res.status(st).json({ error: err.message || 'Error al crear partido' });
    }
  });

  app.get('/api/scoreboard/partidos', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.query.sede_id);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id query param es requerido' });
      }

      const { data, error } = await supabaseAdmin
        .from('scoreboard_partidos')
        .select(SCOREBOARD_PARTIDO_SELECT)
        .eq('sede_id', sedeId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const partidos = (data ?? []).map((row) => enrichPartidoResponse(row));
      return res.json({ partidos });
    } catch (err) {
      console.error('❌ GET /api/scoreboard/partidos:', err.message);
      return res.status(500).json({ error: err.message || 'Error al listar partidos' });
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

  app.patch('/api/scoreboard/partidos/:id', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const partido = await fetchPartido(supabaseAdmin, req.params.id);
      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanControlScoreboard(role, partido.sede_id);

      const body = req.body ?? {};
      const patch = { ...pickColorUniformes(body) };

      const passthrough = [
        'equipo_a_nombre', 'equipo_b_nombre', 'equipo_a_jugadores', 'equipo_b_jugadores',
        'cancha', 'torneo_nombre', 'torneo_id', 'saque_actual', 'color_a', 'color_b',
        'jersey_a1', 'jersey_a2', 'jersey_a3', 'jersey_a4',
        'jersey_b1', 'jersey_b2', 'jersey_b3', 'jersey_b4',
      ];
      for (const key of passthrough) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Ningún campo reconocido para actualizar' });
      }

      const { data, error } = await supabaseAdmin
        .from('scoreboard_partidos')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', partido.id)
        .select(SCOREBOARD_PARTIDO_SELECT)
        .limit(1);

      if (error) throw error;
      const updated = Array.isArray(data) ? data[0] : data;
      if (!updated) return res.status(404).json({ error: 'Partido no encontrado' });

      const enriched = enrichPartidoResponse(updated);
      emitScoreboardUpdate(io, updated.id, updated);
      return res.json(enriched);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ PATCH /api/scoreboard/partidos/:id:', err.message);
      return res.status(st).json({ error: err.message || 'Error al actualizar partido' });
    }
  });

  app.get('/api/scoreboard/cancha-activa/:sedeId/:cancha', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.sedeId);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const cancha = decodeURIComponent(String(req.params.cancha || '').trim());
      if (!cancha) return res.status(400).json({ error: 'cancha inválida' });

      const { data, error } = await supabaseAdmin
        .from('scoreboard_partidos')
        .select('id, equipo_a_nombre, equipo_b_nombre, estado')
        .eq('sede_id', sid)
        .eq('cancha', cancha)
        .neq('estado', 'terminado')
        .order('updated_at', { ascending: false })
        .limit(1);

      if (error) throw error;

      const partido = data?.[0] ?? null;
      if (!partido || !isPartidoActivo(partido.estado)) {
        return res.json({ activo: false });
      }

      const jugadores = await fetchJugadoresTempByPartido(supabaseAdmin, partido.id);

      return res.json({
        partido_id: partido.id,
        nombre_a: partido.equipo_a_nombre,
        nombre_b: partido.equipo_b_nombre,
        jugadores,
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/scoreboard/cancha-activa/:sedeId/:cancha:', err.message);
      return res.status(st).json({ error: err.message || 'Error al obtener cancha activa' });
    }
  });

  app.post('/api/scoreboard/jugador-temp', async (req, res) => {
    try {
      const body = req.body ?? {};
      const partidoId = String(body.partido_id ?? '').trim();
      if (!partidoId) {
        return res.status(400).json({ error: 'partido_id es requerido' });
      }

      const equipo = parseEquipoQr(body.equipo);
      const slot = parseSlotQr(body.slot);
      const nombre = String(body.nombre ?? '').trim();
      if (!nombre) {
        return res.status(400).json({ error: 'nombre es requerido' });
      }

      const partido = await fetchPartido(supabaseAdmin, partidoId);
      if (!isPartidoActivo(partido.estado)) {
        return res.status(400).json({ error: 'El partido ya terminó' });
      }

      const numero = body.numero != null && body.numero !== ''
        ? resolveJerseyNumber(body.numero, slot)
        : null;
      const fotoUrl = body.foto_url != null && String(body.foto_url).trim() !== ''
        ? String(body.foto_url).trim().slice(0, 2048)
        : null;
      const userId = body.user_id != null && String(body.user_id).trim() !== ''
        ? String(body.user_id).trim()
        : null;

      const row = {
        partido_id: partidoId,
        equipo,
        slot,
        nombre: nombre.slice(0, 120),
        numero,
        foto_url: fotoUrl,
        user_id: userId,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('scoreboard_jugadores_temp')
        .upsert(row, { onConflict: 'partido_id,equipo,slot' })
        .select(JUGADOR_TEMP_SELECT)
        .limit(1);

      if (error) throw error;
      const saved = Array.isArray(data) ? data[0] : data;
      return res.status(201).json({ jugador: saved ?? row });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/scoreboard/jugador-temp:', err.message);
      return res.status(st).json({ error: err.message || 'Error al guardar jugador temporal' });
    }
  });

  app.get('/api/scoreboard/jugadores-temp/:partidoId', async (req, res) => {
    try {
      const partidoId = String(req.params.partidoId ?? '').trim();
      if (!partidoId) {
        return res.status(400).json({ error: 'partidoId inválido' });
      }

      const jugadores = await fetchJugadoresTempByPartido(supabaseAdmin, partidoId);
      return res.json({ jugadores });
    } catch (err) {
      console.error('❌ GET /api/scoreboard/jugadores-temp/:partidoId:', err.message);
      return res.status(500).json({ error: err.message || 'Error al obtener jugadores temporales' });
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
        .select(SCOREBOARD_PARTIDO_SELECT)
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
