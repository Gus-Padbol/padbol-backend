import { normalizeSedeAmenities } from '../utils/sedeAmenities.js';

/** PostgREST table names (production uses `public.resenas`). */
const RESENAS_TABLE_CANDIDATES = ['resenas', 'resenas_sedes', 'reseñas_sedes'];

const JUGADORES_PERFIL_EMBED =
  'jugadores_perfil(user_id, nombre, apellido, apodo, username, alias, foto_url, avatar_url)';

function normalizeUserId(raw) {
  if (raw == null || raw === '') return null;
  return String(raw).trim().toLowerCase();
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
      .select('nombre, apellido, apodo, username, foto_url, avatar_url')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  } catch {
    return null;
  }
}

async function insertResenaForSede(supabaseAdmin, payload) {
  for (const table of RESENAS_TABLE_CANDIDATES) {
    try {
      const { data, error } = await supabaseAdmin
        .from(table)
        .insert(payload)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    } catch {
      // try next table name
    }
  }

  return null;
}

async function userHasResenaForSede(supabaseAdmin, sedeId, userId) {
  for (const table of RESENAS_TABLE_CANDIDATES) {
    try {
      const { data, error } = await supabaseAdmin
        .from(table)
        .select('id')
        .eq('sede_id', sedeId)
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (data) return true;
    } catch {
      // try next table
    }
  }

  return false;
}

async function fetchResenasForSede(supabaseAdmin, sedeId) {
  const selectVariants = [
    `id, sede_id, user_id, estrellas, comentario, respuesta_admin, fecha_respuesta, created_at, nombre, ${JUGADORES_PERFIL_EMBED}`,
    `id, sede_id, user_id, estrellas, comentario, created_at, nombre, ${JUGADORES_PERFIL_EMBED}`,
    '*',
  ];

  for (const table of RESENAS_TABLE_CANDIDATES) {
    for (const selectClause of selectVariants) {
      try {
        const { data, error } = await supabaseAdmin
          .from(table)
          .select(selectClause)
          .eq('sede_id', sedeId)
          .order('created_at', { ascending: false })
          .limit(20);

        if (error) throw error;

        const rows = data ?? [];
        console.log(
          `📋 fetchResenasForSede table=${table} select=${selectClause === '*' ? '*' : 'join'} rows=${rows.length}`,
          rows[0] ? JSON.stringify(rows[0]) : '(empty)',
        );
        return rows;
      } catch (err) {
        if (selectClause === '*') {
          console.warn(`⚠️ fetchResenasForSede ${table}:`, err.message);
        }
      }
    }
  }

  return [];
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

  const missingIds = [
    ...new Set(
      list
        .map((row) => normalizeUserId(row.user_id))
        .filter((uid) => uid && !profileByUserId.has(uid)),
    ),
  ];

  if (missingIds.length > 0) {
    try {
      const { data: perfiles, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .select('user_id, nombre, apellido, apodo, username, alias, foto_url, avatar_url')
        .in('user_id', missingIds);

      if (error) throw error;

      console.log(
        `📋 enrichResenasWithProfiles lookup uids=${missingIds.length} perfiles=${perfiles?.length ?? 0}`,
        (perfiles ?? []).slice(0, 3).map((p) => ({
          user_id: p.user_id,
          nombre: p.nombre,
          apodo: p.apodo,
          username: p.username,
        })),
      );

      for (const perfil of perfiles ?? []) {
        const uid = normalizeUserId(perfil?.user_id);
        if (uid) profileByUserId.set(uid, perfil);
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
  const avatar_url = resolvedProfile?.foto_url
    ?? resolvedProfile?.avatar_url
    ?? row.avatar_url
    ?? row.foto_url
    ?? null;
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
    avatar_url,
    display_name,
  };
}

export function mountSedesProfileRoutes(app, { supabase, supabaseAdmin, getAuthenticatedUser }) {
  app.get('/api/sedes/:id/perfil', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

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

  const handleResenas = async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      let rows = [];
      try {
        rows = await fetchResenasForSede(supabaseAdmin, sedeId);
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
          avatar_url: r.avatar_url ? '(set)' : null,
        })),
      );
      let userHasReviewed = false;
      try {
        userHasReviewed = await userHasResenaForSede(supabaseAdmin, sedeId, user.id);
      } catch {
        userHasReviewed = resenas.some((row) => row.user_id === user.id);
      }

      const total = resenas.length;
      const average = total > 0
        ? resenas.reduce((sum, row) => sum + (Number(row.estrellas) || 0), 0) / total
        : null;

      res.json({
        resenas,
        promedio: average != null ? Math.round(average * 10) / 10 : null,
        total,
        user_has_reviewed: userHasReviewed,
      });
    } catch (err) {
      console.error('❌ Error GET /api/sedes/:id/resenas:', err.message);
      res.json({
        resenas: [],
        promedio: null,
        total: 0,
        user_has_reviewed: false,
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

      const profile = await fetchPlayerProfile(supabaseAdmin, user.id);
      const nombreAutor = profile?.apodo
        ?? profile?.username
        ?? [profile?.nombre, profile?.apellido].filter(Boolean).join(' ').trim()
        ?? '';

      const inserted = await insertResenaForSede(supabaseAdmin, {
        sede_id: sedeId,
        user_id: user.id,
        estrellas: stars,
        comentario: trimmedComment || null,
        nombre: nombreAutor,
      });

      if (!inserted) {
        return res.status(500).json({ error: 'No se pudo guardar la reseña' });
      }

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
