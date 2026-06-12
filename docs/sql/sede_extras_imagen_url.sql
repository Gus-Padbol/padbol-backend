-- Imagen opcional por extra de sede (POST/PATCH /api/sedes/:id/extras)
ALTER TABLE public.sede_extras ADD COLUMN IF NOT EXISTS imagen_url TEXT;

COMMENT ON COLUMN public.sede_extras.imagen_url IS 'URL pública de imagen del extra (checkout / admin)';
