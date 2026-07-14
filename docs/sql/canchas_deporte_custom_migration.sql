-- MEJ-07 Fase 1: canchas con deporte personalizado (custom).
-- Idempotente. No crea índice único por nombre personalizado.
-- No modifica CHECK de torneos ni partidos_abiertos.
--
-- Copia operativa para el backend modular (misma DB Supabase que prod).
-- Orden: aplicar en Supabase ANTES de desplegar código que persista metadatos custom.
-- Crear/editar canchas oficiales (sin campos custom) sigue funcionando sin esta migración.

ALTER TABLE public.canchas
  ADD COLUMN IF NOT EXISTS deporte_personalizado TEXT,
  ADD COLUMN IF NOT EXISTS cantidad_jugadores INTEGER,
  ADD COLUMN IF NOT EXISTS modalidad_custom TEXT,
  ADD COLUMN IF NOT EXISTS duracion_sugerida_min INTEGER,
  ADD COLUMN IF NOT EXISTS observacion_custom TEXT;

COMMENT ON COLUMN public.canchas.deporte_personalizado IS
  'Nombre visible del deporte cuando deporte = custom. No es el identificador técnico.';
COMMENT ON COLUMN public.canchas.cantidad_jugadores IS
  'Jugadores sugeridos/requeridos para cancha custom (1-40).';
COMMENT ON COLUMN public.canchas.modalidad_custom IS
  'Modalidad custom: individual | parejas | equipos.';
COMMENT ON COLUMN public.canchas.duracion_sugerida_min IS
  'Duración sugerida informativa en minutos (15-240). No reemplaza sedes_duraciones.';
COMMENT ON COLUMN public.canchas.observacion_custom IS
  'Nota libre opcional para deporte personalizado.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canchas_cantidad_jugadores_range_chk'
      AND conrelid = 'public.canchas'::regclass
  ) THEN
    ALTER TABLE public.canchas
      ADD CONSTRAINT canchas_cantidad_jugadores_range_chk
      CHECK (
        cantidad_jugadores IS NULL
        OR (cantidad_jugadores >= 1 AND cantidad_jugadores <= 40)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canchas_modalidad_custom_chk'
      AND conrelid = 'public.canchas'::regclass
  ) THEN
    ALTER TABLE public.canchas
      ADD CONSTRAINT canchas_modalidad_custom_chk
      CHECK (
        modalidad_custom IS NULL
        OR modalidad_custom IN ('individual', 'parejas', 'equipos')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canchas_duracion_sugerida_min_range_chk'
      AND conrelid = 'public.canchas'::regclass
  ) THEN
    ALTER TABLE public.canchas
      ADD CONSTRAINT canchas_duracion_sugerida_min_range_chk
      CHECK (
        duracion_sugerida_min IS NULL
        OR (duracion_sugerida_min >= 15 AND duracion_sugerida_min <= 240)
      );
  END IF;
END $$;
