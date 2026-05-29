import { normalizeSedeAmenities } from '../utils/sedeAmenities.js';
import {
  enrichSedeWithHeroPhoto,
  capSedeFotoUrls,
  capSedeFotosDestacadas,
  MAX_FOTOS_SEDE,
  normalizeSedeFotoUrls,
  resolveSedeHeroFotoUrl,
} from '../utils/sedeHero.js';
import { fetchSedeUpcomingPartidos } from './partidos.js';

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

  const destacadas = normalizeSedeFotoUrls(sede?.fotos_destacadas);
  for (const url of destacadas) urls.push(url);

  const hero = resolveSedeHeroFotoUrl(sede);
  if (hero) urls.push(hero);

  if (hubImageUrl) urls.push(hubImageUrl);
  if (sede?.foto_url) urls.push(sede.foto_url);

  for (const url of normalizeSedeFotoUrls(sede?.fotos_urls)) {
    urls.push(url);
  }

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

export function mountSedesProfileRoutes(app, { supabase, supabaseAdmin, getAuthenticatedUser }) {
  /** Sesión opcional: lectura pública; con Bearer se enriquecen flags en partidos. */
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

      const sedeEnriched = enrichSedeWithHeroPhoto(sede);
      const deporte = (sedeEnriched.deportes_disponibles?.[0] ?? 'padbol').toLowerCase();
      const hubHero = await fetchHubHeroImage(supabaseAdmin, deporte);
      const fotos = collectSedeFotos(sedeEnriched, hubHero);
      const horarios = buildHorarios(sedeEnriched);
      const coords = buildCoords(sedeEnriched);
      const deportesDisponibles = await fetchDeportesDisponiblesForSede(supabase, sedeId, sedeEnriched);
      const canchasCount = deportesDisponibles.reduce(
        (sum, item) => sum + (item.canchas_count ?? 0),
        0,
      ) || (Number(sedeEnriched.cantidad_canchas) > 0 ? Number(sedeEnriched.cantidad_canchas) : null);

      const tagline = sedeEnriched.slogan ?? sedeEnriched.descripcion ?? null;
      const amenities = normalizeSedeAmenities(sedeEnriched.amenities ?? []);
      const historia = sedeEnriched.historia ?? sedeEnriched.descripcion_larga ?? null;

      res.json({
        sede: sedeEnriched,
        hero_foto_url: sedeEnriched.hero_foto_url ?? null,
        fotos_destacadas: sedeEnriched.fotos_destacadas ?? [],
        fotos,
        slogan: tagline,
        logo_url: sedeEnriched.logo_url ?? null,
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
      if (hop('fotos_destacadas')) {
        const raw = Array.isArray(body.fotos_destacadas) ? body.fotos_destacadas : [];
        patch.fotos_destacadas = capSedeFotosDestacadas(raw);
      }
      if (hop('fotos_urls')) {
        patch.fotos_urls = capSedeFotoUrls(Array.isArray(body.fotos_urls) ? body.fotos_urls : []);
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

      res.json({ sede: enrichSedeWithHeroPhoto(updated) });
    } catch (err) {
      console.error('❌ Error PATCH /api/sedes/:id:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sedes/:id/fotos', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const { foto_base64, mime_type } = req.body ?? {};
      if (!foto_base64) {
        return res.status(400).json({ error: 'foto_base64 es requerido' });
      }

      const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
      const normalizedMime = String(mime_type || 'image/jpeg').toLowerCase();
      if (!allowedMimeTypes.includes(normalizedMime)) {
        return res.status(400).json({ error: 'mime_type de imagen no soportado' });
      }

      const { data: sedeRow, error: fetchErr } = await supabaseAdmin
        .from('sedes')
        .select('id, fotos_urls')
        .eq('id', sedeId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!sedeRow) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const currentFotos = normalizeSedeFotoUrls(sedeRow.fotos_urls);
      if (currentFotos.length >= MAX_FOTOS_SEDE) {
        return res.status(409).json({
          error: `La sede ya tiene el máximo de ${MAX_FOTOS_SEDE} fotos`,
          max_fotos: MAX_FOTOS_SEDE,
        });
      }

      const base64Data = String(foto_base64).replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      if (!buffer.length) {
        return res.status(400).json({ error: 'Imagen inválida' });
      }

      const maxBytes = 2 * 1024 * 1024;
      if (buffer.length > maxBytes) {
        return res.status(400).json({ error: 'La imagen supera el tamaño máximo permitido (2 MB)' });
      }

      const ext = normalizedMime.includes('png')
        ? 'png'
        : normalizedMime.includes('webp')
          ? 'webp'
          : 'jpg';
      const storagePath = `${sedeId}/fotos/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from('sedes')
        .upload(storagePath, buffer, {
          contentType: normalizedMime,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabaseAdmin.storage.from('sedes').getPublicUrl(storagePath);
      const fotoUrl = publicUrlData?.publicUrl;
      if (!fotoUrl) {
        return res.status(500).json({ error: 'No se pudo obtener la URL pública de la foto' });
      }

      const fotos_urls = capSedeFotoUrls([...currentFotos, fotoUrl]);

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('sedes')
        .update({ fotos_urls })
        .eq('id', sedeId)
        .select('*')
        .single();

      if (updateErr) throw updateErr;

      console.log(`✓ POST /api/sedes/${sedeId}/fotos — ${fotos_urls.length}/${MAX_FOTOS_SEDE}`);
      return res.status(201).json({
        ok: true,
        foto_url: fotoUrl,
        fotos_urls,
        sede: enrichSedeWithHeroPhoto(updated),
      });
    } catch (err) {
      console.error('❌ POST /api/sedes/:id/fotos:', err.message);
      return res.status(500).json({ error: err.message || 'Error al subir foto' });
    }
  });
}
