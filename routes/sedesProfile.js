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

async function fetchResenasForSede(supabaseAdmin, sedeId) {
  const tables = ['resenas_sedes', 'reseñas_sedes'];

  for (const table of tables) {
    try {
      const { data, error } = await supabaseAdmin
        .from(table)
        .select('*')
        .eq('sede_id', sedeId)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return data ?? [];
    } catch {
      // try next table name or return empty
    }
  }

  return [];
}

function mapResenaRow(row) {
  return {
    id: row.id,
    sede_id: row.sede_id,
    user_id: row.user_id,
    estrellas: row.estrellas,
    comentario: row.comentario ?? '',
    respuesta_admin: row.respuesta_admin ?? null,
    fecha_respuesta: row.fecha_respuesta ?? null,
    created_at: row.created_at,
    nombre: row.nombre ?? row.autor_nombre ?? 'Jugador',
    avatar_url: row.avatar_url ?? row.foto_url ?? null,
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
      const rawCanchas = sede.cantidad_canchas;
      const canchasCount = rawCanchas != null && Number(rawCanchas) > 0
        ? Number(rawCanchas)
        : null;

      res.json({
        sede,
        fotos,
        slogan: sede.slogan ?? null,
        logo_url: sede.logo_url ?? null,
        horarios,
        canchas_count: canchasCount,
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
      res.status(500).json({ error: err.message });
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

      const rows = await fetchResenasForSede(supabaseAdmin, sedeId);
      const resenas = rows.map(mapResenaRow);

      const total = resenas.length;
      const average = total > 0
        ? resenas.reduce((sum, row) => sum + (Number(row.estrellas) || 0), 0) / total
        : null;

      res.json({
        resenas,
        promedio: average != null ? Math.round(average * 10) / 10 : null,
        total,
      });
    } catch (err) {
      console.error('❌ Error GET /api/sedes/:id/resenas:', err.message);
      res.status(500).json({ error: err.message });
    }
  };

  app.get('/api/sedes/:id/resenas', handleResenas);
  app.get('/api/sedes/:id/reseñas', handleResenas);
}
