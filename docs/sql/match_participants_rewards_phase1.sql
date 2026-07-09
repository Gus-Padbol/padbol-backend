-- Match participants & reward events — PadCoins Fase 1 (Padbol Match)
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Objetivo: reservation → match → participants → validation → rewards
-- Sin ranking casual en esta fase.

-- ─── 1) match_participants ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS match_participants (
  id BIGSERIAL PRIMARY KEY,
  match_type TEXT NOT NULL DEFAULT 'casual',
  match_id TEXT NOT NULL,
  reserva_id BIGINT NULL REFERENCES reservas(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'participant' CHECK (
    role IN ('organizer', 'participant')
  ),
  team TEXT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (
    source IN ('reservation', 'join', 'scoreboard', 'manual', 'admin')
  ),
  attendance_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    attendance_status IN (
      'pending',
      'confirmed',
      'denied',
      'admin_validated',
      'excluded'
    )
  ),
  attendance_confirmed_at TIMESTAMPTZ,
  reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    reward_status IN ('pending', 'eligible', 'credited', 'skipped', 'reversed')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE match_participants IS
  'Participantes identificados por partido/reserva. Base para acreditación PadCoins Fase 1.';
COMMENT ON COLUMN match_participants.match_id IS
  'ID del partido en su dominio (p. ej. partidos_abiertos.id como texto).';
COMMENT ON COLUMN match_participants.attendance_status IS
  'pending no genera ranking ni PadCoins; admin_validated/confirmed habilitan recompensa.';
COMMENT ON COLUMN match_participants.reward_status IS
  'Estado del premio PadCoins para este participante en el partido.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_participants_unique_user
  ON match_participants (match_type, match_id, user_id);

CREATE INDEX IF NOT EXISTS idx_match_participants_reserva_id
  ON match_participants (reserva_id)
  WHERE reserva_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_match_participants_user_id
  ON match_participants (user_id);

CREATE INDEX IF NOT EXISTS idx_match_participants_attendance_status
  ON match_participants (attendance_status);

CREATE INDEX IF NOT EXISTS idx_match_participants_reward_status
  ON match_participants (reward_status);

-- ─── 2) match_reward_events ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS match_reward_events (
  id BIGSERIAL PRIMARY KEY,
  match_type TEXT NOT NULL DEFAULT 'casual',
  match_id TEXT NOT NULL,
  reserva_id BIGINT NULL REFERENCES reservas(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reward_type TEXT NOT NULL CHECK (
    reward_type IN ('padcoins', 'xp', 'ranking')
  ),
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'credited', 'skipped', 'reversed')
  ),
  source_key TEXT NOT NULL,
  padcoins_movimiento_id BIGINT NULL,
  -- Nota: padcoins_movimientos.id en prod es UUID; el backend guarda el link en metadata.movimiento_id.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE match_reward_events IS
  'Ledger idempotente de recompensas por partido. source_key evita duplicados.';
COMMENT ON COLUMN match_reward_events.source_key IS
  'Claves estables: user|reservation|{id}|organizer, user|match|{type}|{id}|padcoins|participant|{userId}, etc.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_reward_events_source_key
  ON match_reward_events (source_key);

CREATE INDEX IF NOT EXISTS idx_match_reward_events_match
  ON match_reward_events (match_type, match_id);

CREATE INDEX IF NOT EXISTS idx_match_reward_events_reserva_id
  ON match_reward_events (reserva_id)
  WHERE reserva_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_match_reward_events_user_id
  ON match_reward_events (user_id);

CREATE INDEX IF NOT EXISTS idx_match_reward_events_status
  ON match_reward_events (status);

-- ─── 3) updated_at trigger (opcional, consistente con otras tablas) ───────────

CREATE OR REPLACE FUNCTION set_match_rewards_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_match_participants_updated_at ON match_participants;
CREATE TRIGGER trg_match_participants_updated_at
  BEFORE UPDATE ON match_participants
  FOR EACH ROW
  EXECUTE FUNCTION set_match_rewards_updated_at();

DROP TRIGGER IF EXISTS trg_match_reward_events_updated_at ON match_reward_events;
CREATE TRIGGER trg_match_reward_events_updated_at
  BEFORE UPDATE ON match_reward_events
  FOR EACH ROW
  EXECUTE FUNCTION set_match_rewards_updated_at();
