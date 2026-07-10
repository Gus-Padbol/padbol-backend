-- Confirmación de asistencia Fase 3.6 — activación por sede
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
-- Idempotente: ADD COLUMN IF NOT EXISTS.
--
-- Reutiliza padbol_match_setup_status (config operativa por sede).
-- Resolución runtime:
--   MATCH_ATTENDANCE_CONFIRMATION_ENABLED=true → habilitado globalmente
--   global OFF + attendance_confirmation_enabled=true en sede → habilitado solo esa sede
--   ambos OFF → deshabilitado (flujo legacy)

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS attendance_confirmation_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN padbol_match_setup_status.attendance_confirmation_enabled IS
  'Opt-in por sede para confirmación de asistencia en partidos casuales (Fase 3.6). Default false.';

CREATE INDEX IF NOT EXISTS idx_padbol_match_setup_status_attendance_confirmation
  ON padbol_match_setup_status (attendance_confirmation_enabled)
  WHERE attendance_confirmation_enabled = TRUE;
