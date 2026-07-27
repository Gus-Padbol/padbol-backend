import express from 'express';
import multer from 'multer';
import {
  requireContentEditorUser,
  requireSuperAdminUser,
} from '../lib/authAccess.js';

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
  'comunidad',
  'perfil',
  'mis_partidos',
]);
const VALID_AD_SLOTS = new Set([
  'app_general',
  'hub_footer',
  'hub_inline',
  'stadium_home',
  'competir_hub',
]);
const VALID_MEDIA_TYPES = new Set(['image', 'video']);
const VALID_CONTENT_TYPES = new Set(['hub', 'ad']);
const VALID_DRAFT_STATUSES = new Set(['draft', 'pending_review', 'rejected', 'approved']);
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

function mapDraftRow(row) {
  return {
    content_type: row.content_type,
    deporte: row.deporte,
    item_key: row.item_key,
    payload: row.payload ?? {},
    status: VALID_DRAFT_STATUSES.has(row.status) ? row.status : 'draft',
    review_note: row.review_note ?? '',
    submitted_at: row.submitted_at ?? null,
    reviewed_at: row.reviewed_at ?? null,
    published_at: row.published_at ?? null,
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

function validateContentTarget(contentType, deporte, itemKey) {
  if (!VALID_CONTENT_TYPES.has(contentType) || !VALID_DEPORTES.has(deporte)) {
    return false;
  }
  return contentType === 'hub'
    ? VALID_CARD_KEYS.has(itemKey)
    : VALID_AD_SLOTS.has(itemKey);
}

function buildHubPayload(deporte, cardKey, body) {
  const mediaType = normalizeMediaType(body?.media_type);
  const payload = {
    deporte,
    card_key: cardKey,
    titulo: normalizedValue(body?.titulo, 140) ?? '',
    subtitulo: normalizedValue(body?.subtitulo, 280) ?? '',
    imagen_url: normalizedValue(body?.imagen_url),
    media_type: mediaType,
    video_url: mediaType === 'video' ? normalizedValue(body?.video_url) : null,
    poster_url: mediaType === 'video' ? normalizedValue(body?.poster_url) : null,
  };
  if (mediaType === 'video' && !payload.video_url) {
    return { error: 'Un video necesita su URL de video' };
  }
  return { payload };
}

function buildAdPayload(deporte, slotKey, body) {
  const mediaType = normalizeMediaType(body?.media_type);
  return {
    payload: {
      deporte,
      slot_key: slotKey,
      titulo: normalizedValue(body?.titulo, 140) ?? '',
      media_type: mediaType,
      imagen_url: normalizedValue(body?.imagen_url),
      video_url: mediaType === 'video' ? normalizedValue(body?.video_url) : null,
      poster_url: mediaType === 'video' ? normalizedValue(body?.poster_url) : null,
      destino_url: normalizedValue(body?.destino_url),
      activo: body?.activo !== false,
    },
  };
}

function buildPayload(contentType, deporte, itemKey, body) {
  return contentType === 'hub'
    ? buildHubPayload(deporte, itemKey, body)
    : buildAdPayload(deporte, itemKey, body);
}

export const contentWorkflowInternals = {
  buildPayload,
  mapDraftRow,
  validateContentTarget,
};

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

  async function saveDraft(req, res, contentType, deporte, itemKey, body) {
    if (!validateContentTarget(contentType, deporte, itemKey)) {
      return res.status(400).json({ error: 'Contenido o deporte inválido' });
    }
    const built = buildPayload(contentType, deporte, itemKey, body);
    if (built.error) return res.status(400).json({ error: built.error });

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('content_editor_drafts')
      .upsert({
        content_type: contentType,
        deporte,
        item_key: itemKey,
        payload: built.payload,
        status: 'draft',
        updated_by: req.contentAuth.user.id,
        review_note: null,
        submitted_at: null,
        reviewed_at: null,
        reviewed_by: null,
        published_at: null,
        updated_at: now,
      }, { onConflict: 'content_type,deporte,item_key' })
      .select('content_type, deporte, item_key, payload, status, review_note, submitted_at, reviewed_at, published_at, updated_at')
      .single();
    if (error) throw error;
    return res.json({ draft: mapDraftRow(data) });
  }

  router.get('/drafts', async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;
    const status = normalizedValue(req.query.status, 32)?.toLowerCase();
    if (status && !VALID_DRAFT_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    try {
      let query = supabaseAdmin
        .from('content_editor_drafts')
        .select('content_type, deporte, item_key, payload, status, review_note, submitted_at, reviewed_at, published_at, updated_at')
        .order('updated_at', { ascending: false });
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw error;
      return res.json({
        items: (data ?? []).map(mapDraftRow),
        can_approve: auth.role.rol === 'super_admin',
      });
    } catch {
      return res.status(500).json({
        error: 'No se pudieron cargar los borradores. Verificá la migración editorial.',
      });
    }
  });

  router.put('/drafts/:contentType/:deporte/:itemKey', async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;
    req.contentAuth = auth;
    const contentType = normalizedValue(req.params.contentType, 16)?.toLowerCase();
    const deporte = normalizedValue(req.params.deporte, 32)?.toLowerCase();
    const itemKey = normalizedValue(req.params.itemKey, 64)?.toLowerCase();

    try {
      return await saveDraft(req, res, contentType, deporte, itemKey, req.body);
    } catch {
      return res.status(500).json({
        error: 'No se pudo guardar el borrador. Verificá la migración editorial.',
      });
    }
  });

  router.post('/drafts/:contentType/:deporte/:itemKey/submit', async (req, res) => {
    const auth = await requireContentEditorUser(req, res, contentDeps(deps));
    if (!auth) return;
    const contentType = normalizedValue(req.params.contentType, 16)?.toLowerCase();
    const deporte = normalizedValue(req.params.deporte, 32)?.toLowerCase();
    const itemKey = normalizedValue(req.params.itemKey, 64)?.toLowerCase();
    if (!validateContentTarget(contentType, deporte, itemKey)) {
      return res.status(400).json({ error: 'Contenido o deporte inválido' });
    }

    try {
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('content_editor_drafts')
        .update({
          status: 'pending_review',
          submitted_at: now,
          updated_by: auth.user.id,
          updated_at: now,
          review_note: null,
        })
        .eq('content_type', contentType)
        .eq('deporte', deporte)
        .eq('item_key', itemKey)
        .select('content_type, deporte, item_key, payload, status, review_note, submitted_at, reviewed_at, published_at, updated_at')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Primero guardá el borrador' });
      return res.json({ draft: mapDraftRow(data) });
    } catch {
      return res.status(500).json({ error: 'No se pudo enviar a revisión' });
    }
  });

  router.post('/drafts/:contentType/:deporte/:itemKey/approve', async (req, res) => {
    const auth = await requireSuperAdminUser(req, res, contentDeps(deps));
    if (!auth) return;
    const contentType = normalizedValue(req.params.contentType, 16)?.toLowerCase();
    const deporte = normalizedValue(req.params.deporte, 32)?.toLowerCase();
    const itemKey = normalizedValue(req.params.itemKey, 64)?.toLowerCase();
    if (!validateContentTarget(contentType, deporte, itemKey)) {
      return res.status(400).json({ error: 'Contenido o deporte inválido' });
    }

    try {
      const draftResult = await supabaseAdmin
        .from('content_editor_drafts')
        .select('content_type, deporte, item_key, payload, status')
        .eq('content_type', contentType)
        .eq('deporte', deporte)
        .eq('item_key', itemKey)
        .maybeSingle();
      if (draftResult.error) throw draftResult.error;
      if (!draftResult.data) return res.status(404).json({ error: 'Borrador inexistente' });
      if (draftResult.data.status !== 'pending_review') {
        return res.status(409).json({ error: 'El contenido no está pendiente de aprobación' });
      }

      const now = new Date().toISOString();
      const payload = { ...draftResult.data.payload, updated_at: now };
      const target = contentType === 'hub' ? 'hub_deporte_config' : 'content_ad_slots';
      const conflict = contentType === 'hub' ? 'deporte,card_key' : 'deporte,slot_key';
      const published = await supabaseAdmin
        .from(target)
        .upsert(payload, { onConflict: conflict });
      if (published.error) throw published.error;

      const reviewed = await supabaseAdmin
        .from('content_editor_drafts')
        .update({
          status: 'approved',
          reviewed_by: auth.user.id,
          reviewed_at: now,
          published_at: now,
          review_note: normalizedValue(req.body?.note, 500),
          updated_at: now,
        })
        .eq('content_type', contentType)
        .eq('deporte', deporte)
        .eq('item_key', itemKey)
        .select('content_type, deporte, item_key, payload, status, review_note, submitted_at, reviewed_at, published_at, updated_at')
        .single();
      if (reviewed.error) throw reviewed.error;
      return res.json({ draft: mapDraftRow(reviewed.data), published: true });
    } catch {
      return res.status(500).json({ error: 'No se pudo aprobar y publicar el contenido' });
    }
  });

  router.post('/drafts/:contentType/:deporte/:itemKey/reject', async (req, res) => {
    const auth = await requireSuperAdminUser(req, res, contentDeps(deps));
    if (!auth) return;
    const contentType = normalizedValue(req.params.contentType, 16)?.toLowerCase();
    const deporte = normalizedValue(req.params.deporte, 32)?.toLowerCase();
    const itemKey = normalizedValue(req.params.itemKey, 64)?.toLowerCase();
    if (!validateContentTarget(contentType, deporte, itemKey)) {
      return res.status(400).json({ error: 'Contenido o deporte inválido' });
    }
    const note = normalizedValue(req.body?.note, 500);
    if (!note) return res.status(400).json({ error: 'Indicá qué hay que corregir' });

    try {
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('content_editor_drafts')
        .update({
          status: 'rejected',
          reviewed_by: auth.user.id,
          reviewed_at: now,
          review_note: note,
          updated_at: now,
        })
        .eq('content_type', contentType)
        .eq('deporte', deporte)
        .eq('item_key', itemKey)
        .eq('status', 'pending_review')
        .select('content_type, deporte, item_key, payload, status, review_note, submitted_at, reviewed_at, published_at, updated_at')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: 'El contenido no está pendiente' });
      return res.json({ draft: mapDraftRow(data) });
    } catch {
      return res.status(500).json({ error: 'No se pudo devolver el contenido' });
    }
  });

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

    try {
      req.contentAuth = auth;
      return await saveDraft(req, res, 'hub', deporte, cardKey, req.body);
    } catch {
      return res.status(500).json({ error: 'No se pudo guardar el borrador de la card' });
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

    try {
      req.contentAuth = auth;
      return await saveDraft(req, res, 'ad', deporte, slotKey, req.body);
    } catch {
      return res.status(500).json({
        error: 'No se pudo guardar el borrador de publicidad. Verificá la migración editorial.',
      });
    }
  });

  return router;
}
