-- Backfill hora_fin para reservas existentes (La Meca, sede_id = 1).
-- Ejecutar en Supabase SQL Editor.

UPDATE reservas
SET hora_fin = (hora_inicio::time + interval '90 minutes')::time
WHERE hora_fin IS NULL
  AND sede_id = 1;
