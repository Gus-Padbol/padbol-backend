-- MEJ-04 Fase 1 — precios por duración y disciplina (sedes_duraciones)
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
-- NO borra columnas legacy en sedes (precio_60min, precio_90min, precio_120min, etc.).
-- NO borra precios_por_deporte ni franjas_precio.
-- NO sobrescribe datos existentes de La Meca ni otras sedes.
--
-- Semántica deporte:
--   NULL  → precio base de la sede para esa duración (aplica a cualquier disciplina sin override).
--   valor → override por disciplina (padbol, padel, pickleball, tenis).

-- 1) Columna deporte (nullable)
ALTER TABLE sedes_duraciones
  ADD COLUMN IF NOT EXISTS deporte TEXT NULL;

COMMENT ON COLUMN sedes_duraciones.deporte IS
  'NULL = precio base de sede para la duración; valor = override por disciplina.';

-- 2) Índice único por sede + disciplina (NULL → base) + duración
--    Si existe un UNIQUE viejo solo sobre (sede_id, duracion_minutos), hay que retirarlo
--    antes de crear el índice nuevo. Este bloque busca constraints únicos de 2 columnas
--    que incluyan sede_id + duracion_minutos pero NO deporte.
DO $$
DECLARE
  r RECORD;
  col_count INT;
  has_sede BOOLEAN;
  has_duracion BOOLEAN;
  has_deporte BOOLEAN;
BEGIN
  FOR r IN
    SELECT c.oid, c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = 'sedes_duraciones'
      AND n.nspname = 'public'
      AND c.contype = 'u'
  LOOP
    SELECT count(*)::INT INTO col_count
    FROM unnest((SELECT conkey FROM pg_constraint WHERE oid = r.oid)) AS ck(attnum);

    SELECT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = (SELECT conrelid FROM pg_constraint WHERE oid = r.oid)
        AND a.attnum = ANY((SELECT conkey FROM pg_constraint WHERE oid = r.oid))
        AND a.attname = 'sede_id'
    ) INTO has_sede;

    SELECT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = (SELECT conrelid FROM pg_constraint WHERE oid = r.oid)
        AND a.attnum = ANY((SELECT conkey FROM pg_constraint WHERE oid = r.oid))
        AND a.attname = 'duracion_minutos'
    ) INTO has_duracion;

    SELECT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = (SELECT conrelid FROM pg_constraint WHERE oid = r.oid)
        AND a.attnum = ANY((SELECT conkey FROM pg_constraint WHERE oid = r.oid))
        AND a.attname = 'deporte'
    ) INTO has_deporte;

    IF has_sede AND has_duracion AND NOT has_deporte AND col_count = 2 THEN
      RAISE NOTICE 'MEJ-04: dropping legacy unique constraint % on sedes_duraciones', r.conname;
      EXECUTE format('ALTER TABLE public.sedes_duraciones DROP CONSTRAINT IF EXISTS %I', r.conname);
    END IF;
  END LOOP;
END $$;

-- Índices únicos legacy por nombre (idempotente; no falla si no existen)
DROP INDEX IF EXISTS public.sedes_duraciones_sede_id_duracion_minutos_key;
DROP INDEX IF EXISTS public.sedes_duraciones_sede_duracion_uidx;
DROP INDEX IF EXISTS public.idx_sedes_duraciones_sede_duracion;

CREATE UNIQUE INDEX IF NOT EXISTS sedes_duraciones_sede_deporte_duracion_uidx
  ON public.sedes_duraciones (sede_id, COALESCE(deporte, ''), duracion_minutos);

-- 3) Índice para consultas por sede + deporte activo
CREATE INDEX IF NOT EXISTS idx_sedes_duraciones_sede_deporte_activo
  ON public.sedes_duraciones (sede_id, deporte)
  WHERE activo = TRUE;

-- 4) Filas existentes: deporte permanece NULL (precio base).
--    No se insertan ni actualizan precios de La Meca ni de otras sedes en este script.
