-- Foto de portada / hero de la sede (URL pública en Storage)
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

ALTER TABLE public.sedes ADD COLUMN IF NOT EXISTS foto_portada text;

COMMENT ON COLUMN public.sedes.foto_portada IS 'URL de la foto de portada/hero de la sede';
