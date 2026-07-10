-- Match attendance confirmation — Fase 3.0 (preparación schema, NO ejecutado).
-- Idempotente: ADD COLUMN IF NOT EXISTS. No modifica datos históricos.

-- ─── partidos_abiertos: ventana de confirmación ───────────────────────────────

ALTER TABLE partidos_abiertos
  ADD COLUMN IF NOT EXISTS attendance_collection_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS attendance_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attendance_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attendance_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attendance_resolution_reason TEXT,
  ADD COLUMN IF NOT EXISTS rewards_processed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partidos_abiertos_attendance_collection_status_check'
  ) THEN
    ALTER TABLE partidos_abiertos
      ADD CONSTRAINT partidos_abiertos_attendance_collection_status_check
      CHECK (attendance_collection_status IN (
        'none', 'open', 'expired', 'ready', 'credited', 'blocked'
      ));
  END IF;
END $$;

COMMENT ON COLUMN partidos_abiertos.attendance_collection_status IS
  'Estado de la ventana de confirmación de asistencia (Fase 3+)';
COMMENT ON COLUMN partidos_abiertos.attendance_opened_at IS
  'Inicio de ventana ¿Jugaste este partido? (Fase 3+)';
COMMENT ON COLUMN partidos_abiertos.attendance_deadline_at IS
  'Fin de plazo para responder asistencia (Fase 3+)';
COMMENT ON COLUMN partidos_abiertos.attendance_resolved_at IS
  'Cierre/resolución de la ventana de asistencia (Fase 3+)';
COMMENT ON COLUMN partidos_abiertos.attendance_resolution_reason IS
  'Motivo de resolución: all_confirmed, timeout_partial, admin_override, etc. (Fase 3+)';
COMMENT ON COLUMN partidos_abiertos.rewards_processed_at IS
  'Timestamp de acreditación PadCoins/Ranking tras ventana (Fase 3+)';

CREATE INDEX IF NOT EXISTS idx_partidos_abiertos_attendance_open
  ON partidos_abiertos (attendance_collection_status, attendance_deadline_at)
  WHERE attendance_collection_status IN ('open', 'expired');

-- ─── match_participants: respuesta del jugador ────────────────────────────────

ALTER TABLE match_participants
  ADD COLUMN IF NOT EXISTS attendance_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attendance_responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attendance_response_source TEXT,
  ADD COLUMN IF NOT EXISTS attendance_denial_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'match_participants_attendance_response_source_check'
  ) THEN
    ALTER TABLE match_participants
      ADD CONSTRAINT match_participants_attendance_response_source_check
      CHECK (
        attendance_response_source IS NULL
        OR attendance_response_source IN (
          'player', 'admin', 'system_timeout', 'system_legacy'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN match_participants.attendance_requested_at IS
  'Cuándo se envió el prompt de confirmación de asistencia (Fase 3+)';
COMMENT ON COLUMN match_participants.attendance_responded_at IS
  'Cuándo el jugador/admin/system respondió asistencia (Fase 3+)';
COMMENT ON COLUMN match_participants.attendance_response_source IS
  'Origen de la respuesta: player, admin, system_timeout, system_legacy (Fase 3+)';
COMMENT ON COLUMN match_participants.attendance_denial_reason IS
  'Motivo opcional cuando attendance_status = denied (Fase 3+)';

CREATE INDEX IF NOT EXISTS idx_match_participants_attendance_pending
  ON match_participants (match_type, match_id, attendance_status)
  WHERE attendance_status = 'pending';
