import express from 'express';
import { safeQueryLog } from '../lib/safeLog.js';

const CARD_KEYS = [
  'reservar',
  'buscar_partido',
  'torneos',
  'rankings',
  'armar_partido',
  'comunidad',
  'perfil',
  'mis_partidos',
];

const VALID_DEPORTES = new Set([
  'padbol',
  'padel',
  'pickleball',
  'squash',
  'tenis',
  'futbol_5',
  'futbol_7',
]);

const STATIC_HUB_IMAGES = {
  padbol: {
    reservar: 'https://images.unsplash.com/photo-1554068865-24cecd893e86?auto=format&fit=crop&w=1200&q=80',
    buscar_partido: 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80',
    torneos: 'https://images.unsplash.com/photo-1461896836934-ff60756a9cb0?auto=format&fit=crop&w=1200&q=80',
    armar_partido: 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80',
  },
  padel: {
    reservar: 'https://images.unsplash.com/photo-1554068865-24cecd893e86?auto=format&fit=crop&w=1200&q=80',
    buscar_partido: 'https://images.unsplash.com/photo-1622163642999-9584a4a0a976?auto=format&fit=crop&w=1200&q=80',
    torneos: 'https://images.unsplash.com/photo-1599586120429-48281b6f0ece?auto=format&fit=crop&w=1200&q=80',
    armar_partido: 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80',
  },
  pickleball: {
    reservar: 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=1200&q=80',
    buscar_partido: 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=1200&q=80',
    torneos: 'https://images.unsplash.com/photo-1461896836934-ff60756a9cb0?auto=format&fit=crop&w=1200&q=80',
    armar_partido: 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80',
  },
  squash: {
    reservar: 'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?auto=format&fit=crop&w=1200&q=80',
    buscar_partido: 'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?auto=format&fit=crop&w=1200&q=80',
    torneos: 'https://images.unsplash.com/photo-1461896836934-ff60756a9cb0?auto=format&fit=crop&w=1200&q=80',
    armar_partido: 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80',
  },
  tenis: {
    reservar: 'https://images.unsplash.com/photo-1595435934249-5df7ed347e1f?auto=format&fit=crop&w=1200&q=80',
    buscar_partido: 'https://images.unsplash.com/photo-1622163642999-9584a4a0a976?auto=format&fit=crop&w=1200&q=80',
    torneos: 'https://images.unsplash.com/photo-1595435934249-5df7ed347e1f?auto=format&fit=crop&w=1200&q=80',
    armar_partido: 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80',
  },
  futbol_5: {
    reservar: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=1200&q=80',
    buscar_partido: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1200&q=80',
    torneos: 'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&w=1200&q=80',
    armar_partido: 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=1200&q=80',
  },
  futbol_7: {
    reservar: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=1200&q=80',
    buscar_partido: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1200&q=80',
    torneos: 'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&w=1200&q=80',
    armar_partido: 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=1200&q=80',
  },
};

function mapCardResponse(row, staticImageUrl) {
  return {
    image_url: row?.imagen_url ?? staticImageUrl ?? null,
    titulo: row?.titulo ?? null,
    subtitulo: row?.subtitulo ?? null,
    media_type: row?.media_type ?? 'image',
    video_url: row?.video_url ?? null,
    poster_url: row?.poster_url ?? null,
  };
}

function buildResponseFromStatic(deporte) {
  const staticImages = STATIC_HUB_IMAGES[deporte] ?? {};
  return CARD_KEYS.reduce((acc, cardKey) => {
    acc[cardKey] = mapCardResponse(null, staticImages[cardKey] ?? null);
    return acc;
  }, {});
}

function buildResponseFromRows(rows, deporte) {
  const byKey = Object.fromEntries(rows.map((row) => [row.card_key, row]));

  return CARD_KEYS.reduce((acc, cardKey) => {
    acc[cardKey] = mapCardResponse(
      byKey[cardKey],
      STATIC_HUB_IMAGES[deporte]?.[cardKey] ?? null,
    );
    return acc;
  }, {});
}

export function createHubRouter({ supabaseAdmin }) {
  const router = express.Router();

  router.get('/imagenes', async (req, res) => {
    try {
      console.log('GET /api/hub/imagenes hit', {
        deporte: req.query.deporte,
        query: safeQueryLog(req.query),
      });

      const deporte = String(req.query.deporte ?? 'padbol').trim().toLowerCase();
      console.log('GET /api/hub/imagenes deporte param:', deporte);

      if (!VALID_DEPORTES.has(deporte)) {
        return res.status(400).json({ error: 'deporte inválido' });
      }

      let rows = [];
      try {
        const { data, error } = await supabaseAdmin
          .from('hub_deporte_config')
          .select('card_key, titulo, subtitulo, imagen_url, media_type, video_url, poster_url')
          .eq('deporte', deporte);

        if (error && /column/i.test(String(error.message))) {
          const legacy = await supabaseAdmin
            .from('hub_deporte_config')
            .select('card_key, titulo, subtitulo, imagen_url')
            .eq('deporte', deporte);
          if (legacy.error) throw legacy.error;
          rows = legacy.data ?? [];
        } else if (error) {
          throw error;
        } else {
          rows = data ?? [];
        }
        console.log('GET /api/hub/imagenes DB result:', {
          deporte,
          rowCount: rows.length,
        });
      } catch (dbError) {
        console.warn('⚠️ hub_deporte_config no disponible, usando config estática:', dbError.message);
        return res.json(buildResponseFromStatic(deporte));
      }

      if (rows.length === 0) {
        console.log('GET /api/hub/imagenes sin filas, usando config estática para:', deporte);
        return res.json(buildResponseFromStatic(deporte));
      }

      const payload = buildResponseFromRows(rows, deporte);
      console.log('GET /api/hub/imagenes response', { deporte, cardCount: Object.keys(payload ?? {}).length });
      res.json(payload);
    } catch (err) {
      console.error('❌ Error GET /api/hub/imagenes:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createHubRouter;
