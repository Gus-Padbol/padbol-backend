-- Espacio de trabajo editorial: cards del Hub con imagen o video.
-- Seguro para volver a ejecutar.

ALTER TABLE public.hub_deporte_config
  ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS video_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS poster_url TEXT NULL;

ALTER TABLE public.hub_deporte_config
  DROP CONSTRAINT IF EXISTS hub_deporte_config_media_type_check;

ALTER TABLE public.hub_deporte_config
  ADD CONSTRAINT hub_deporte_config_media_type_check
  CHECK (media_type IN ('image', 'video'));

-- El bucket es público porque las cards se sirven dentro de la app sin sesión.
INSERT INTO storage.buckets (id, name, public)
VALUES ('content-media', 'content-media', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Content media public read" ON storage.objects;
CREATE POLICY "Content media public read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'content-media');

-- Las subidas llegan sólo desde el backend con service_role; no se abre escritura directa.

COMMENT ON COLUMN public.hub_deporte_config.media_type IS
  'image | video. Video se publica con poster_url para superficies sin reproducción.';
COMMENT ON COLUMN public.hub_deporte_config.video_url IS
  'URL pública del video editorial.';
COMMENT ON COLUMN public.hub_deporte_config.poster_url IS
  'Imagen de portada de un video editorial.';

CREATE TABLE IF NOT EXISTS public.content_ad_slots (
  id BIGSERIAL PRIMARY KEY,
  deporte TEXT NOT NULL,
  slot_key TEXT NOT NULL DEFAULT 'app_general',
  titulo TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'image'
    CHECK (media_type IN ('image', 'video')),
  imagen_url TEXT NULL,
  video_url TEXT NULL,
  poster_url TEXT NULL,
  destino_url TEXT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deporte, slot_key)
);

CREATE INDEX IF NOT EXISTS idx_content_ad_slots_public
ON public.content_ad_slots (deporte, slot_key, activo);

COMMENT ON TABLE public.content_ad_slots IS
  'Publicidad editorial de la app. app_general sirve de respaldo para espacios dinámicos.';
