-- Notificaciones: alinear schema con docs (columna data JSONB).
-- Producción actual (2026-07): id, user_id, tipo, titulo NOT NULL, mensaje, leida, link, created_at.
-- El backend soporta ambos modos: data JSONB (preferido) o metadata en link (fallback).
-- NO ejecutado en producción — aplicar manualmente cuando corresponda.

ALTER TABLE public.notificaciones
  ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.notificaciones.data IS
  'Metadata de navegación y dedupe (partido_id, dedupe_key, action, source, deadline_at).';

CREATE INDEX IF NOT EXISTS idx_notificaciones_user_data_dedupe
  ON public.notificaciones (user_id, ((data ->> 'dedupe_key')))
  WHERE data ? 'dedupe_key';
