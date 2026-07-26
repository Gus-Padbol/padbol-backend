import express from 'express';

function mapPublicAd(row) {
  const mediaType = row?.media_type === 'video' ? 'video' : 'image';
  return {
    titulo: row?.titulo ?? null,
    media_type: mediaType,
    image_url: mediaType === 'video'
      ? (row?.poster_url ?? row?.imagen_url ?? null)
      : (row?.imagen_url ?? null),
    video_url: mediaType === 'video' ? row?.video_url ?? null : null,
    poster_url: row?.poster_url ?? null,
    destino_url: row?.destino_url ?? null,
  };
}

export function createContentPublicRouter({ supabaseAdmin }) {
  const router = express.Router();

  router.get('/ads', async (req, res) => {
    const deporte = String(req.query.deporte ?? 'padbol').trim().toLowerCase();
    const slotKey = String(req.query.slot_key ?? 'app_general').trim().toLowerCase();

    try {
      const { data, error } = await supabaseAdmin
        .from('content_ad_slots')
        .select('titulo, media_type, imagen_url, video_url, poster_url, destino_url, activo, slot_key')
        .eq('deporte', deporte)
        .eq('activo', true)
        .in('slot_key', [slotKey, 'app_general'])
        .order('slot_key', { ascending: false })
        .limit(1);
      if (error) throw error;
      return res.json({ ad: data?.[0] ? mapPublicAd(data[0]) : null });
    } catch {
      // Content is optional: consumers keep their static fallback before migration/deploy.
      return res.json({ ad: null });
    }
  });

  return router;
}
