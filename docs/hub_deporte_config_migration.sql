-- Hub action card images per sport
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

CREATE TABLE IF NOT EXISTS hub_deporte_config (
  id BIGSERIAL PRIMARY KEY,
  deporte TEXT NOT NULL,
  card_type TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deporte, card_type)
);

CREATE INDEX IF NOT EXISTS idx_hub_deporte_config_deporte ON hub_deporte_config (deporte);

COMMENT ON TABLE hub_deporte_config IS 'Imágenes de tarjetas del hub por deporte y tipo de acción';
COMMENT ON COLUMN hub_deporte_config.card_type IS 'reservar | buscar_partido | torneos | armar_partido';

INSERT INTO hub_deporte_config (deporte, card_type, image_url) VALUES
  ('padbol', 'reservar', 'https://images.unsplash.com/photo-1554068865-24cecd893e86?auto=format&fit=crop&w=1200&q=80'),
  ('padbol', 'buscar_partido', 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80'),
  ('padbol', 'torneos', 'https://images.unsplash.com/photo-1461896836934-ff60756a9cb0?auto=format&fit=crop&w=1200&q=80'),
  ('padbol', 'armar_partido', 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80'),
  ('padel', 'reservar', 'https://images.unsplash.com/photo-1554068865-24cecd893e86?auto=format&fit=crop&w=1200&q=80'),
  ('padel', 'buscar_partido', 'https://images.unsplash.com/photo-1622163642999-9584a4a0a976?auto=format&fit=crop&w=1200&q=80'),
  ('padel', 'torneos', 'https://images.unsplash.com/photo-1599586120429-48281b6f0ece?auto=format&fit=crop&w=1200&q=80'),
  ('padel', 'armar_partido', 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80'),
  ('pickleball', 'reservar', 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=1200&q=80'),
  ('pickleball', 'buscar_partido', 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?auto=format&fit=crop&w=1200&q=80'),
  ('pickleball', 'torneos', 'https://images.unsplash.com/photo-1461896836934-ff60756a9cb0?auto=format&fit=crop&w=1200&q=80'),
  ('pickleball', 'armar_partido', 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80'),
  ('squash', 'reservar', 'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?auto=format&fit=crop&w=1200&q=80'),
  ('squash', 'buscar_partido', 'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?auto=format&fit=crop&w=1200&q=80'),
  ('squash', 'torneos', 'https://images.unsplash.com/photo-1461896836934-ff60756a9cb0?auto=format&fit=crop&w=1200&q=80'),
  ('squash', 'armar_partido', 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80'),
  ('tenis', 'reservar', 'https://images.unsplash.com/photo-1595435934249-5df7ed347e1f?auto=format&fit=crop&w=1200&q=80'),
  ('tenis', 'buscar_partido', 'https://images.unsplash.com/photo-1622163642999-9584a4a0a976?auto=format&fit=crop&w=1200&q=80'),
  ('tenis', 'torneos', 'https://images.unsplash.com/photo-1595435934249-5df7ed347e1f?auto=format&fit=crop&w=1200&q=80'),
  ('tenis', 'armar_partido', 'https://images.unsplash.com/photo-1551958219-acbc608c6377?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_5', 'reservar', 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_5', 'buscar_partido', 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_5', 'torneos', 'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_5', 'armar_partido', 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_7', 'reservar', 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_7', 'buscar_partido', 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_7', 'torneos', 'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&w=1200&q=80'),
  ('futbol_7', 'armar_partido', 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=1200&q=80')
ON CONFLICT (deporte, card_type) DO NOTHING;
