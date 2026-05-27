import { normalizeSedeAmenities } from '../utils/sedeAmenities.js';
import { fetchSedeUpcomingPartidos } from './partidos.js';

/** Venue reviews live in public.resenas_sedes only. */
const RESENAS_TABLE = 'resenas_sedes';

const ELIGIBLE_RESERVA_ESTADOS = ['confirmada', 'completada'];

const NO_ELIGIBLE_RESENA = {
  error: 'no_eligible',
  message: 'Debes haber reservado o jugado un torneo en este club para poder reseñarlo.',
};

const JUGADORES_PERFIL_EMBED =
  'jugadores_perfil(user_id, nombre, apellido, apodo, username, alias, foto_url)';

/** Mirrors SQL: jp.user_id::text = r.user_id::text (avoids UUID casing mismatches). */
function normalizeUserId(raw) {
  if (raw == null || raw === '') return null;
  return String(raw).trim().toLowerCase();
}

function resenaUserMatchesProfile(resenaUserId, profileUserId) {
  const a = normalizeUserId(resenaUserId);
  const b = normalizeUserId(profileUserId);
  return Boolean(a && b && a === b);
}

function extractEmbeddedProfile(row) {
  const embedded = row?.jugadores_perfil;
  if (Array.isArray(embedded)) return embedded[0] ?? null;
  if (embedded && typeof embedded === 'object') return embedded;
  return null;
}

function parseSedeId(raw) {
  const sedeId = parseInt(raw, 10);
  if (Number.isNaN(sedeId)) return null;
  return sedeId;
}

function getTodayDateStr() {
  const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const year = nowAR.getFullYear();
  const month = String(nowAR.getMonth() + 1).padStart(2, '0');
  const day = String(nowAR.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatHorario(hora) {
  if (!hora) return null;
  return String(hora).slice(0, 5);
}

function buildHorarios(sede) {
  const apertura = formatHorario(sede?.horario_apertura);
  const cierre = formatHorario(sede?.horario_cierre);
  let label = null;

  if (apertura && cierre) label = `${apertura} – ${cierre}`;
  else if (apertura) label = `Desde ${apertura}`;
  else if (cierre) label = `Hasta ${cierre}`;

  return { apertura, cierre, label };
}

function buildCoords(sede) {
  const lat = sede?.latitud ?? sede?.latitude;
  const lng = sede?.longitud ?? sede?.longitude;
  if (lat == null || lng == null) return null;

  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return { latitude, longitude };
}

function collectSedeFotos(sede, hubImageUrl = null) {
  const urls = [];

  if (hubImageUrl) urls.push(hubImageUrl);
  if (sede?.foto_url) urls.push(sede.foto_url);

  for (const item of sede?.imagenes ?? []) {
    const url = typeof item === 'string' ? item : item?.url;
    if (url) urls.push(url);
  }

  return [...new Set(urls.filter(Boolean))];
}

function normalizeDeporteKey(value) {
  const key = String(value ?? 'padbol').trim().toLowerCase();
  if (key === 'futbol') return 'futbol_5';
  return key || 'padbol';
}

async function fetchDeportesDisponiblesForSede(supabase, sedeId, sede) {
  const tables = ['canchas', 'cancha'];

  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('deporte, sport, tipo_deporte, id')
        .eq('sede_id', sedeId);

      if (error) throw error;
      if (!data?.length) continue;

      const counts = new Map();
      for (const row of data) {
        const deporte = normalizeDeporteKey(row.deporte ?? row.sport ?? row.tipo_deporte);
        counts.set(deporte, (counts.get(deporte) ?? 0) + 1);
      }

      return [...counts.entries()]
        .map(([deporte, canchas_count]) => ({ deporte, canchas_count }))
        .sort((a, b) => a.deporte.localeCompare(b.deporte));
    } catch {
      // try next table or fallback
    }
  }

  const deportesList = Array.isArray(sede?.deportes_disponibles) && sede.deportes_disponibles.length > 0
    ? sede.deportes_disponibles.map(normalizeDeporteKey)
    : ['padbol'];

  const uniqueDeportes = [...new Set(deportesList)];
  const totalCanchas = Number(sede?.cantidad_canchas) > 0
    ? Number(sede.cantidad_canchas)
    : uniqueDeportes.length;

  return uniqueDeportes.map((deporte, index) => {
    const base = Math.floor(totalCanchas / uniqueDeportes.length);
    const remainder = totalCanchas % uniqueDeportes.length;
    const canchas_count = base + (index < remainder ? 1 : 0);
    return {
      deporte,
      canchas_count: Math.max(canchas_count, 1),
    };
  });
}

async function fetchHubHeroImage(supabaseAdmin, deporte = 'padbol') {
  try {
    const { data, error } = await supabaseAdmin
      .from('hub_deporte_config')
      .select('imagen_url')
      .eq('deporte', deporte)
      .eq('card_key', 'reservar')
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data?.imagen_url ?? null;
  } catch {
    return null;
  }
}

async function fetchPlayerProfile(supabaseAdmin, userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('nombre, apellido, apodo, username, foto_url')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  } catch {
    return null;
  }
}

async function userHasEligibleReservaInSede(supabaseAdmin, sedeId, userId) {
  if (!userId) return false;

  const { count, error } = await supabaseAdmin
    .from('reservas')
    .select('id', { count: 'exact', head: true })
    .eq('sede_id', sedeId)
    .eq('user_id', userId)
    .in('estado', ELIGIBLE_RESERVA_ESTADOS);

  if (!error && (count ?? 0) > 0) return true;

  const missingSedeIdColumn = error?.code === '42703'
    || String(error?.message ?? '').toLowerCase().includes('sede_id');
  if (error && !missingSedeIdColumn) throw error;

  const { data: sedeRow, error: sedeError } = await supabaseAdmin
    .from('sedes')
    .select('nombre')
    .eq('id', sedeId)
    .maybeSingle();

  if (sedeError) throw sedeError;
  const sedeNombre = String(sedeRow?.nombre ?? '').trim();
  if (!sedeNombre) return false;

  const { count: byNameCount, error: byNameError } = await supabaseAdmin
    .from('reservas')
    .select('id', { count: 'exact', head: true })
    .eq('sede', sedeNombre)
    .eq('user_id', userId)
    .in('estado', ELIGIBLE_RESERVA_ESTADOS);

  if (byNameError) throw byNameError;
  return (byNameCount ?? 0) > 0;
}

async function userHasTorneoParticipationInSede(supabaseAdmin, sedeId, userId) {
  if (!userId) return false;

  const { data: torneos, error: torneosError } = await supabaseAdmin
    .from('torneos')
    .select('id')
    .eq('sede_id', sedeId);

  if (torneosError) throw torneosError;

  const torneoIds = (torneos ?? []).map((row) => row.id).filter((id) => id != null);
  if (torneoIds.length === 0) return false;

  const torneoPlayerTables = ['torneos_jugadores', 'jugadores_torneo'];

  for (const table of torneoPlayerTables) {
    const { count, error } = await supabaseAdmin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('torneo_id', torneoIds);

    if (!error && (count ?? 0) > 0) return true;

    const tableMissing = error?.code === '42P01'
      || error?.code === 'PGRST205'
      || String(error?.message ?? '').toLowerCase().includes(table);
    if (tableMissing) continue;
    if (error) throw error;
  }

  return false;
}

async function userIsEligibleForSedeResena(supabaseAdmin, sedeId, userId) {
  const [hasReserva, hasTorneo] = await Promise.all([
    userHasEligibleReservaInSede(supabaseAdmin, sedeId, userId),
    userHasTorneoParticipationInSede(supabaseAdmin, sedeId, userId),
  ]);
  return hasReserva || hasTorneo;
}

async function insertResenaForSede(supabaseAdmin, payload) {
  const { data, error } = await supabaseAdmin
    .from(RESENAS_TABLE)
    .insert(payload)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function userHasResenaForSede(supabaseAdmin, sedeId, userId) {
  const { data, error } = await supabaseAdmin
    .from(RESENAS_TABLE)
    .select('id')
    .eq('sede_id', sedeId)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

function buildStarDistribution(rows) {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of rows ?? []) {
    const star = Math.round(Number(row.estrellas));
    if (star >= 1 && star <= 5) {
      distribution[star] += 1;
    }
  }
  return distribution;
}

async function fetchResenasStatsForSede(supabaseAdmin, sedeId) {
  const { data: allStars, error } = await supabaseAdmin
    .from(RESENAS_TABLE)
    .select('estrellas')
    .eq('sede_id', sedeId);

  if (error) throw error;

  const rows = allStars ?? [];
  const total_count = rows.length;
  const distribution = buildStarDistribution(rows);
  const average = total_count > 0
    ? rows.reduce((sum, row) => sum + (Number(row.estrellas) || 0), 0) / total_count
    : null;

  return {
    total_count,
    distribution,
    promedio: average != null ? Math.round(average * 10) / 10 : null,
  };
}

async function fetchResenasForSede(supabaseAdmin, sedeId, { page = 1, limit = 20 } = {}) {
  const rowLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const pageNum = Math.max(1, Number(page) || 1);
  const offset = (pageNum - 1) * rowLimit;
  const rangeEnd = offset + rowLimit - 1;

  const selectVariants = [
    `*, ${JUGADORES_PERFIL_EMBED}`,
    'id, sede_id, user_id, estrellas, comentario, respuesta_admin, fecha_respuesta, created_at',
    '*',
  ];

  let lastError = null;

  for (const selectClause of selectVariants) {
    const { data, error } = await supabaseAdmin
      .from(RESENAS_TABLE)
      .select(selectClause)
      .eq('sede_id', sedeId)
      .order('created_at', { ascending: false })
      .range(offset, rangeEnd);

    if (!error) {
      const rows = data ?? [];
      console.log(
        `📋 fetchResenasForSede ${RESENAS_TABLE} page=${pageNum} limit=${rowLimit} rows=${rows.length}`,
        rows[0] ? JSON.stringify(rows[0]) : '(empty)',
      );
      return rows;
    }

    lastError = error;
  }

  throw lastError ?? new Error(`No se pudieron leer reseñas de ${RESENAS_TABLE}`);
}

async function enrichResenasWithProfiles(supabaseAdmin, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const profileByUserId = new Map();

  for (const row of list) {
    const uid = normalizeUserId(row.user_id);
    if (!uid) continue;
    const embedded = extractEmbeddedProfile(row);
    if (embedded) profileByUserId.set(uid, embedded);
  }

  const missingUserIds = [
    ...new Set(
      list
        .map((row) => row.user_id)
        .filter((uid) => uid && !profileByUserId.has(normalizeUserId(uid))),
    ),
  ];

  if (missingUserIds.length > 0) {
    try {
      const { data: perfiles, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .select('user_id, nombre, apellido, apodo, username, alias, foto_url')
        .in('user_id', missingUserIds);

      if (error) throw error;

      console.log(
        `📋 enrichResenasWithProfiles JOIN resenas_sedes↔jugadores_perfil uids=${missingUserIds.length} perfiles=${perfiles?.length ?? 0}`,
        (perfiles ?? []).slice(0, 3).map((p) => ({
          user_id: p.user_id,
          nombre: p.nombre,
          apodo: p.apodo,
          username: p.username,
        })),
      );

      for (const row of list) {
        if (profileByUserId.has(normalizeUserId(row.user_id))) continue;
        const match = (perfiles ?? []).find((p) => resenaUserMatchesProfile(row.user_id, p.user_id));
        if (match) profileByUserId.set(normalizeUserId(row.user_id), match);
      }
    } catch (err) {
      console.warn('⚠️ enrichResenasWithProfiles jugadores_perfil:', err.message);
    }
  }

  return list.map((row) => {
    const uid = normalizeUserId(row.user_id);
    const profile = (uid && profileByUserId.get(uid)) || extractEmbeddedProfile(row);
    return mapResenaRow(row, profile);
  });
}

function mapResenaRow(row, profile = null) {
  const resolvedProfile = profile ?? extractEmbeddedProfile(row);
  const nombrePerfil = [resolvedProfile?.nombre, resolvedProfile?.apellido].filter(Boolean).join(' ').trim();
  const nombreGuardado = String(row.nombre ?? row.autor_nombre ?? '').trim();
  const nombre = nombrePerfil || nombreGuardado || null;
  const apodo = String(resolvedProfile?.apodo ?? row.apodo ?? '').trim() || null;
  const usernameRaw = resolvedProfile?.username ?? resolvedProfile?.alias ?? row.username ?? '';
  const username = String(usernameRaw).trim().replace(/^@+/, '') || null;
  const foto_url = resolvedProfile?.foto_url ?? row.foto_url ?? null;
  const display_name = apodo || nombre || 'Usuario';

  return {
    id: row.id,
    sede_id: row.sede_id,
    user_id: row.user_id,
    estrellas: row.estrellas,
    comentario: row.comentario ?? '',
    respuesta_admin: row.respuesta_admin ?? null,
    fecha_respuesta: row.fecha_respuesta ?? null,
    created_at: row.created_at,
    nombre,
    apodo,
    username,
    foto_url,
    display_name,
  };
}

export function mountSedesProfileRoutes(app, { supabase, supabaseAdmin, getAuthenticatedUser }) {
  /** Sesión opcional: lectura pública; con Bearer se enriquecen flags de reseñas. */
  async function optionalAuthUser(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  }

  app.get('/api/sedes/:id/perfil', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const { data: sede, error } = await supabase
        .from('sedes')
        .select('*')
        .eq('id', sedeId)
        .maybeSingle();

      if (error) throw error;
      if (!sede) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const deporte = (sede.deportes_disponibles?.[0] ?? 'padbol').toLowerCase();
      const hubHero = await fetchHubHeroImage(supabaseAdmin, deporte);
      const fotos = collectSedeFotos(sede, hubHero);
      const horarios = buildHorarios(sede);
      const coords = buildCoords(sede);
      const deportesDisponibles = await fetchDeportesDisponiblesForSede(supabase, sedeId, sede);
      const canchasCount = deportesDisponibles.reduce(
        (sum, item) => sum + (item.canchas_count ?? 0),
        0,
      ) || (Number(sede.cantidad_canchas) > 0 ? Number(sede.cantidad_canchas) : null);

      const tagline = sede.slogan ?? sede.descripcion ?? null;
      const amenities = normalizeSedeAmenities(sede.amenities ?? []);
      const historia = sede.historia ?? sede.descripcion_larga ?? null;

      res.json({
        sede,
        fotos,
        slogan: tagline,
        logo_url: sede.logo_url ?? null,
        descripcion: historia,
        historia,
        amenities,
        horarios,
        canchas_count: canchasCount,
        deportes_disponibles: deportesDisponibles,
        coords,
      });
    } catch (err) {
      console.error('❌ Error GET /api/sedes/:id/perfil:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sedes/:id/torneos', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const upcoming = String(req.query.upcoming ?? '').toLowerCase() === 'true';
      const today = getTodayDateStr();

      let query = supabase
        .from('torneos')
        .select('*')
        .eq('sede_id', sedeId);

      if (upcoming) {
        query = query
          .gte('fecha_inicio', today)
          .neq('estado', 'finalizado')
          .order('fecha_inicio', { ascending: true })
          .limit(3);
      } else {
        query = query.order('fecha_inicio', { ascending: false }).limit(10);
      }

      const { data, error } = await query;
      if (error) throw error;

      res.json({ torneos: data ?? [] });
    } catch (err) {
      console.error('❌ Error GET /api/sedes/:id/torneos:', err.message);
      res.json({ torneos: [] });
    }
  });

  app.get('/api/sedes/:id/partidos', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const upcoming = String(req.query.upcoming ?? '').toLowerCase() === 'true';
      if (!upcoming) {
        return res.status(400).json({ error: 'Usá upcoming=true para listar partidos próximos' });
      }

      const limitRaw = parseInt(String(req.query.limit ?? '3'), 10);
      const limit = Number.isFinite(limitRaw) ? limitRaw : 3;

      const user = await optionalAuthUser(req);
      const partidos = await fetchSedeUpcomingPartidos(supabaseAdmin, sedeId, user, { limit });
      res.json({ partidos });
    } catch (err) {
      console.error('❌ Error GET /api/sedes/:id/partidos:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  const handleResenas = async (req, res) => {
    try {
      const user = await optionalAuthUser(req);

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const pageRaw = parseInt(String(req.query.page ?? '1'), 10);
      const limitRaw = parseInt(String(req.query.limit ?? '20'), 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const listLimit = Number.isFinite(limitRaw)
        ? Math.min(100, Math.max(1, limitRaw))
        : 20;

      let rows = [];
      try {
        rows = await fetchResenasForSede(supabaseAdmin, sedeId, { page, limit: listLimit });
      } catch (fetchErr) {
        console.warn('⚠️ fetchResenasForSede:', fetchErr.message);
      }

      const resenas = await enrichResenasWithProfiles(supabaseAdmin, rows);
      console.log(
        `📋 GET /api/sedes/${sedeId}/resenas enriched=${resenas.length}`,
        resenas.slice(0, 3).map((r) => ({
          user_id: r.user_id,
          display_name: r.display_name,
          username: r.username,
          foto_url: r.foto_url ? '(set)' : null,
        })),
      );
      let userHasReviewed = false;
      if (user?.id) {
        try {
          userHasReviewed = await userHasResenaForSede(supabaseAdmin, sedeId, user.id);
        } catch {
          userHasReviewed = resenas.some((row) => resenaUserMatchesProfile(row.user_id, user.id));
        }
      }

      let total_count = resenas.length;
      let promedio = null;
      let distribution = buildStarDistribution(resenas);
      try {
        const stats = await fetchResenasStatsForSede(supabaseAdmin, sedeId);
        total_count = stats.total_count;
        promedio = stats.promedio;
        distribution = stats.distribution;
      } catch {
        if (resenas.length > 0) {
          total_count = resenas.length;
          promedio = resenas.reduce((sum, row) => sum + (Number(row.estrellas) || 0), 0) / resenas.length;
          distribution = buildStarDistribution(resenas);
        }
      }

      const offset = (page - 1) * listLimit;
      const has_more = offset + resenas.length < total_count;

      let userIsEligible = false;
      if (user?.id) {
        try {
          userIsEligible = await userIsEligibleForSedeResena(supabaseAdmin, sedeId, user.id);
        } catch (eligibilityErr) {
          console.warn('⚠️ userIsEligibleForSedeResena:', eligibilityErr.message);
        }
      }

      res.json({
        resenas,
        promedio,
        total: total_count,
        total_count,
        page,
        limit: listLimit,
        has_more,
        distribution,
        user_has_reviewed: userHasReviewed,
        user_is_eligible: userIsEligible,
      });
    } catch (err) {
      console.error('❌ Error GET /api/sedes/:id/resenas:', err.message);
      res.json({
        resenas: [],
        promedio: null,
        total: 0,
        total_count: 0,
        page: 1,
        limit: 20,
        has_more: false,
        distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        user_has_reviewed: false,
        user_is_eligible: false,
      });
    }
  };

  app.get('/api/sedes/:id/resenas', handleResenas);
  app.get('/api/sedes/:id/reseñas', handleResenas);

  const handlePostResena = async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const { estrellas, comentario, user_id: bodyUserId } = req.body ?? {};
      const stars = Number(estrellas);

      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return res.status(400).json({ error: 'Seleccioná una calificación de 1 a 5 estrellas' });
      }

      if (bodyUserId && bodyUserId !== user.id) {
        return res.status(403).json({ error: 'No podés publicar reseñas en nombre de otro usuario' });
      }

      const trimmedComment = String(comentario ?? '').trim();
      if (trimmedComment.length > 500) {
        return res.status(400).json({ error: 'El comentario no puede superar 500 caracteres' });
      }

      const { data: sede, error: sedeError } = await supabase
        .from('sedes')
        .select('id')
        .eq('id', sedeId)
        .maybeSingle();

      if (sedeError) throw sedeError;
      if (!sede) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const alreadyReviewed = await userHasResenaForSede(supabaseAdmin, sedeId, user.id);
      if (alreadyReviewed) {
        return res.status(409).json({ error: 'Ya reseñaste este club' });
      }

      const isEligible = await userIsEligibleForSedeResena(supabaseAdmin, sedeId, user.id);
      if (!isEligible) {
        return res.status(403).json(NO_ELIGIBLE_RESENA);
      }

      const profile = await fetchPlayerProfile(supabaseAdmin, user.id);

      const inserted = await insertResenaForSede(supabaseAdmin, {
        sede_id: sedeId,
        user_id: user.id,
        estrellas: stars,
        comentario: trimmedComment || null,
      });

      const resena = mapResenaRow(inserted, profile);

      res.status(201).json({ resena });
    } catch (err) {
      console.error('❌ Error POST /api/sedes/:id/resenas:', err.message);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/api/sedes/:id/resenas', handlePostResena);
  app.post('/api/sedes/:id/reseñas', handlePostResena);

  app.patch('/api/sedes/:id', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const body = req.body ?? {};
      const patch = {};
      const hop = (key) => Object.prototype.hasOwnProperty.call(body, key);

      if (hop('amenities')) {
        patch.amenities = normalizeSedeAmenities(body.amenities);
      }
      if (hop('descripcion')) {
        const text = String(body.descripcion ?? '').trim();
        patch.descripcion = text ? text.slice(0, 300) : null;
      }
      if (hop('slogan')) {
        const text = String(body.slogan ?? '').trim();
        patch.slogan = text ? text.slice(0, 300) : null;
      }
      if (hop('historia')) {
        const text = String(body.historia ?? '').trim();
        patch.historia = text ? text.slice(0, 500) : null;
      }

      const passthrough = [
        'nombre', 'direccion', 'ciudad', 'provincia', 'pais', 'telefono', 'email_contacto',
        'horario_apertura', 'horario_cierre', 'moneda', 'metodo_pago', 'pago_manual_instrucciones',
        'instagram', 'facebook', 'tiktok', 'twitter', 'youtube', 'website',
        'color_fondo_logo', 'color_hero_primario', 'color_hero_secundario', 'color_borde_hero',
        'mp_access_token', 'stripe_account_id',
      ];
      for (const key of passthrough) {
        if (hop(key)) patch[key] = body[key];
      }
      if (hop('latitud')) patch.latitud = body.latitud == null || body.latitud === '' ? null : Number(body.latitud);
      if (hop('longitud')) patch.longitud = body.longitud == null || body.longitud === '' ? null : Number(body.longitud);

      /** Precios por duración (columnas en `sedes`; ver sedes_precios_por_duracion.sql). */
      const parsePrecioDuracion = (raw, fieldName) => {
        if (raw === null || raw === '') return null;
        const p = Number(String(raw).replace(/\./g, '').replace(',', '.'));
        if (!Number.isFinite(p) || p < 0) {
          throw Object.assign(new Error(`${fieldName} inválido`), { statusCode: 400 });
        }
        return Math.round(p);
      };
      const precioKeys = [
        ['precio_60min', 'precio_60'],
        ['precio_90min', 'precio_90'],
        ['precio_120min', 'precio_120'],
        ['precio_turno', null],
      ];
      for (const [canonical, alias] of precioKeys) {
        const sourceKey = hop(canonical) ? canonical : alias && hop(alias) ? alias : null;
        if (!sourceKey) continue;
        try {
          patch[canonical] = parsePrecioDuracion(body[sourceKey], canonical);
        } catch (e) {
          const st = e.statusCode || 400;
          return res.status(st).json({ error: e.message || String(e) });
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(patch, 'precio_90min') &&
        patch.precio_90min != null
      ) {
        patch.precio_turno = patch.precio_90min;
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Ningún campo reconocido para actualizar' });
      }

      const { data: updated, error } = await supabase
        .from('sedes')
        .update(patch)
        .eq('id', sedeId)
        .select('*')
        .single();

      if (error) throw error;
      if (!updated) return res.status(404).json({ error: 'Sede no encontrada' });

      res.json({ sede: updated });
    } catch (err) {
      console.error('❌ Error PATCH /api/sedes/:id:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
