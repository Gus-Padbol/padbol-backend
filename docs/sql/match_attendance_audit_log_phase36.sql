-- Confirmación de asistencia Fase 3.6 — auditoría append-only
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
-- Idempotente: CREATE TABLE IF NOT EXISTS.
--
-- El backend registra acciones admin con fallback silencioso si la tabla no existe.
-- Deploy de escritura de auditoría requiere este SQL aplicado.

CREATE TABLE IF NOT EXISTS match_attendance_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id INTEGER NOT NULL,
  actor_user_id UUID,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_user_id UUID,
  previous_status TEXT,
  new_status TEXT,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT match_attendance_audit_action_nonempty CHECK (char_length(trim(action)) > 0)
);

COMMENT ON TABLE match_attendance_audit_log IS
  'Auditoría append-only de overrides admin y cierres forzados de asistencia (Fase 3.6).';

CREATE INDEX IF NOT EXISTS idx_match_attendance_audit_match_id
  ON match_attendance_audit_log (match_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_match_attendance_audit_actor_user_id
  ON match_attendance_audit_log (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_match_attendance_audit_target_user_id
  ON match_attendance_audit_log (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;
