import express from 'express';
import multer from 'multer';
import { requireContentEditorUser } from '../lib/authAccess.js';

const VALID_DEPORTES = new Set([
  'padbol',
  'padel',
  'pickleball',
  'squash',
  'tenis',
  'futbol_5',
  'futbol_7',
]);
const VALID_CARD_KEYS = new Set([
  'reservar',
  'buscar_partido',
  'torneos',
  'rankings',
  'armar_partido',
]);
const VALID_AD_SLOTS = new Set([
  'app_general',
  'hub_footer',
  'hub_inline',
  'stadium_home',
  'competir_hub',
]);
const VALID_MEDIA_TYPES = new Set(['image', 'video']);
const CONTENT_MEDIA_BUCKET = 'content-media';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

function normalizedValue(value, maxLength = 3000) {
  const text = String(value ?? '').trim();
  return text.slice(0, maxLength) || null;
}

function normalizeMediaType(value) {
  const type = String(value ?? 'image').trim().toLowerCase();
  return VALID_MEDIA_TYPES.has(type) ? type : 'image';
}

function mapHubRow(row) {
  return {
    deporte: row.deporte,
    card_key: row.card_key,
    titulo: row.titulo ?? '',
    subtitulo: row.subtitulo ?? '',
    imagen_url: row.imagen_url ?? null,
    media_type: normalizeMediaType(row.media_type),
    video_url: row.video_url ?? null,
    poster_url: row.poster_url ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function mapAdRow(row) {
  return {
    deporte: row.deporte,
    slot_key: row.slot_key,
    titulo: row.titulo ?? '',
    media_type: normalizeMediaType(row.media_type),
    imagen_url: row.imagen_url ?? null,
    video_url: row.video_url ?? null,
    poster_url: row.poster_url ?? null,
    destino_url: row.destino_url ?? null,
    activo: row.activo !== false,
    updated_at: row.updated_at ?? null,
  };
}

function contentDeps(deps) {
  return {
    getAuthenticatedUser: deps.getAuthenticatedUser,
    fetchUserRoleRowForAuthUser: deps.fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails: deps.legacySuperAdminEmails ?? [],
  };
}

export function createContentAdminRouter({
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const router = express.Router();
  const deps = {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  };

  router.get('/hub', async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;
    const deporte = normalizedValue(req.query.deporte, 32)?.toLowerCase();
    if (deporte && !VALID_DEPORTES.has(deporte)) {
      return res.status(400).json({ error: 'Deporte inválido' });
    }

    try {
      let query = supabaseAdmin
        .from('hub_deporte_config')
        .select('deporte, card_key, titulo, subtitulo, imagen_url, media_type, video_url, poster_url, updated_at')
        .order('deporte')
        .order('card_key');
      if (deporte) query = query.eq('deporte', deporte);
      let { data, error } = await query;

      if (error && /column/i.test(String(error.message))) {
        let legacyQuery = supabaseAdmin
          .from('hub_deporte_config')
          .select('deporte, card_key, titulo, subtitulo, imagen_url, updated_at')
          .order('deporte')
          .order('card_key');
        if (deporte) legacyQuery = legacyQuery.eq('deporte', deporte);
        ({ data, error } = await legacyQuery);
      }
      if (error) throw error;
      return res.json({ items: (data ?? []).map(mapHubRow) });
    } catch {
      return res.status(500).json({ error: 'No se pudo cargar el contenido del Hub' });
    }
  });

  router.put('/hub/:deporte/:cardKey', async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;
    const deporte = normalizedValue(req.params.deporte, 32)?.toLowerCase();
    const cardKey = normalizedValue(req.params.cardKey, 64)?.toLowerCase();
    if (!VALID_DEPORTES.has(deporte) || !VALID_CARD_KEYS.has(cardKey)) {
      return res.status(400).json({ error: 'Card o deporte inválido' });
    }

    const mediaType = normalizeMediaType(req.body?.media_type);
    const payload = {
      deporte,
      card_key: cardKey,
      titulo: normalizedValue(req.body?.titulo, 140) ?? '',
      subtitulo: normalizedValue(req.body?.subtitulo, 280) ?? '',
      imagen_url: normalizedValue(req.body?.imagen_url),
      media_type: mediaType,
      video_url: mediaType === 'video' ? normalizedValue(req.body?.video_url) : null,
      poster_url: mediaType === 'video' ? normalizedValue(req.body?.poster_url) : null,
      updated_at: new Date().toISOString(),
    };
    if (mediaType === 'video' && !payload.video_url) {
      return res.status(400).json({ error: 'Un video necesita su URL de video' });
    }

    try {
      const result = await supabaseAdmin
        .from('hub_deporte_config')
        .upsert(payload, { onConflict: 'deporte,card_key' })
        .select('deporte, card_key, titulo, subtitulo, imagen_url, media_type, video_url, poster_url, updated_at')
        .single();
      if (result.error && /column/i.test(String(result.error.message))) {
        return res.status(409).json({
          error: 'Falta ejecutar la migración de Contenido antes de guardar videos.',
        });
      }
      if (result.error) throw result.error;
      return res.json({ item: mapHubRow(result.data) });
    } catch {
      return res.status(500).json({ error: 'No se pudo guardar la card' });
    }
  });

  router.post('/media', upload.single('file'), async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Seleccioná un archivo' });
    const isImage = /^image\//.test(file.mimetype);
    const isVideo = /^video\//.test(file.mimetype);
    if (!isImage && !isVideo) {
      return res.status(400).json({ error: 'Solo se permiten imágenes o videos' });
    }

    const fallbackExtension = isVideo ? 'mp4' : 'jpg';
    const ext = (file.originalname.split('.').pop() || fallbackExtension)
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();
    const path = `editorial/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

    try {
      const { error } = await supabaseAdmin.storage
        .from(CONTENT_MEDIA_BUCKET)
        .upload(path, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });
      if (error) throw error;
      const { data } = supabaseAdmin.storage.from(CONTENT_MEDIA_BUCKET).getPublicUrl(path);
      return res.status(201).json({
        url: data.publicUrl,
        media_type: isVideo ? 'video' : 'image',
      });
    } catch {
      return res.status(500).json({
        error: 'No se pudo subir el archivo. Verificá el bucket content-media.',
      });
    }
  });

  router.get('/ads', async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;

    try {
      const { data, error } = await supabaseAdmin
        .from('content_ad_slots')
        .select('deporte, slot_key, titulo, media_type, imagen_url, video_url, poster_url, destino_url, activo, updated_at')
        .order('deporte')
        .order('slot_key');
      if (error) throw error;
      return res.json({ items: (data ?? []).map(mapAdRow) });
    } catch {
      return res.status(500).json({
        error: 'No se pudo cargar la publicidad. Verificá la migración de Contenido.',
      });
    }
  });

  router.put('/ads/:deporte/:slotKey', async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;
    const deporte = normalizedValue(req.params.deporte, 32)?.toLowerCase();
    const slotKey = normalizedValue(req.params.slotKey, 64)?.toLowerCase();
    if (!VALID_DEPORTES.has(deporte) || !VALID_AD_SLOTS.has(slotKey)) {
      return res.status(400).json({ error: 'Espacio o deporte inválido' });
    }

    const mediaType = normalizeMediaType(req.body?.media_type);
    const payload = {
      deporte,
      slot_key: slotKey,
      titulo: normalizedValue(req.body?.titulo, 140) ?? '',
      media_type: mediaType,
      imagen_url: normalizedValue(req.body?.imagen_url),
      video_url: mediaType === 'video' ? normalizedValue(req.body?.video_url) : null,
      poster_url: mediaType === 'video' ? normalizedValue(req.body?.poster_url) : null,
      destino_url: normalizedValue(req.body?.destino_url),
      activo: req.body?.activo !== false,
      updated_at: new Date().toISOString(),
    };

    try {
      const { data, error } = await supabaseAdmin
        .from('content_ad_slots')
        .upsert(payload, { onConflict: 'deporte,slot_key' })
        .select('deporte, slot_key, titulo, media_type, imagen_url, video_url, poster_url, destino_url, activo, updated_at')
        .single();
      if (error) throw error;
      return res.json({ item: mapAdRow(data) });
    } catch {
      return res.status(500).json({
        error: 'No se pudo guardar la publicidad. Verificá la migración de Contenido.',
      });
    }
  });

  return router;
}
