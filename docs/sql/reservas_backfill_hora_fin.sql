-- Backfill columnas hora_inicio / hora_fin (text) en reservas existentes.
-- Ejecutar en Supabase SQL Editor.

-- 1) Poblar hora_inicio desde hora legacy si falta
UPDATE reservas
SET hora_inicio = trim(split_part(hora, ' - ', 1))
WHERE (hora_inicio IS NULL OR trim(hora_inicio) = '')
  AND hora IS NOT NULL
  AND trim(hora) <> '';

-- 2) Backfill hora_fin para La Meca (sede_id = 1)
UPDATE reservas
SET hora_fin = to_char(
  (
    COALESCE(
      NULLIF(trim(hora_inicio), ''),
      NULLIF(trim(split_part(hora, ' - ', 1)), '')
    )::time + interval '90 minutes'
  ),
  'HH24:MI'
)
WHERE hora_fin IS NULL
  AND sede_id = 1;
