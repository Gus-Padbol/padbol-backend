-- PadCoins — campañas automáticas por sede
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- La sede define campañas agresivas bajo su responsabilidad comercial.
-- Super Admin audita vía padcoins_campaign_audit_logs y alertas high_impact.

-- ─── 1) padcoins_campaigns ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS padcoins_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id INTEGER NOT NULL REFERENCES sedes (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  campaign_type TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  multiplier NUMERIC(8, 2),
  loyalty_percentage_override INTEGER,
  fixed_padcoins INTEGER,
  benefit_id UUID REFERENCES premios_canjeables (id) ON DELETE SET NULL,
  max_total_uses INTEGER,
  max_uses_per_player INTEGER,
  estimated_cost_reference INTEGER,
  high_impact BOOLEAN NOT NULL DEFAULT FALSE,
  message_title TEXT,
  message_body TEXT,
  segment_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT padcoins_campaigns_name_nonempty CHECK (char_length(trim(name)) > 0),
  CONSTRAINT padcoins_campaigns_type_check CHECK (
    campaign_type IN ('multiplier', 'percentage_override', 'fixed_padcoins', 'benefit_equivalent')
  ),
  CONSTRAINT padcoins_campaigns_status_check CHECK (
    status IN ('draft', 'active', 'paused', 'ended')
  ),
  CONSTRAINT padcoins_campaigns_dates_check CHECK (end_at > start_at),
  CONSTRAINT padcoins_campaigns_multiplier_nonneg CHECK (
    multiplier IS NULL OR multiplier >= 0
  ),
  CONSTRAINT padcoins_campaigns_loyalty_pct_nonneg CHECK (
    loyalty_percentage_override IS NULL OR loyalty_percentage_override >= 0
  ),
  CONSTRAINT padcoins_campaigns_fixed_nonneg CHECK (
    fixed_padcoins IS NULL OR fixed_padcoins >= 0
  ),
  CONSTRAINT padcoins_campaigns_max_total_nonneg CHECK (
    max_total_uses IS NULL OR max_total_uses > 0
  ),
  CONSTRAINT padcoins_campaigns_max_player_nonneg CHECK (
    max_uses_per_player IS NULL OR max_uses_per_player > 0
  ),
  CONSTRAINT padcoins_campaigns_estimated_cost_nonneg CHECK (
    estimated_cost_reference IS NULL OR estimated_cost_reference >= 0
  )
);

COMMENT ON TABLE padcoins_campaigns IS
  'Campañas PadCoins por sede. La sede opera bajo marco global; Super Admin audita.';
COMMENT ON COLUMN padcoins_campaigns.high_impact IS
  'Marcada automáticamente si el impacto estimado es alto; no bloquea activación.';
COMMENT ON COLUMN padcoins_campaigns.segment_config IS
  'Segmentación futura (JSON). Vacío = todos los jugadores elegibles.';

CREATE INDEX IF NOT EXISTS idx_padcoins_campaigns_sede_id
  ON padcoins_campaigns (sede_id);

CREATE INDEX IF NOT EXISTS idx_padcoins_campaigns_sede_status_dates
  ON padcoins_campaigns (sede_id, status, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_padcoins_campaigns_active
  ON padcoins_campaigns (sede_id, start_at, end_at)
  WHERE status = 'active';

-- ─── 2) padcoins_campaign_audit_logs ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS padcoins_campaign_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES padcoins_campaigns (id) ON DELETE CASCADE,
  sede_id INTEGER NOT NULL REFERENCES sedes (id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_user_id UUID,
  actor_role TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  high_impact BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT padcoins_campaign_audit_action_nonempty CHECK (char_length(trim(action)) > 0)
);

COMMENT ON TABLE padcoins_campaign_audit_logs IS
  'Trazabilidad de campañas PadCoins para Super Admin.';

CREATE INDEX IF NOT EXISTS idx_padcoins_campaign_audit_campaign_id
  ON padcoins_campaign_audit_logs (campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_padcoins_campaign_audit_sede_id
  ON padcoins_campaign_audit_logs (sede_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_padcoins_campaign_audit_high_impact
  ON padcoins_campaign_audit_logs (high_impact, created_at DESC)
  WHERE high_impact = TRUE;

-- ─── 3) padcoins_campaign_applications ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS padcoins_campaign_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES padcoins_campaigns (id) ON DELETE CASCADE,
  sede_id INTEGER NOT NULL REFERENCES sedes (id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  reserva_id TEXT,
  movimiento_id UUID REFERENCES padcoins_movimientos (id) ON DELETE SET NULL,
  base_padcoins INTEGER NOT NULL DEFAULT 0,
  final_padcoins INTEGER NOT NULL DEFAULT 0,
  calculation_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT padcoins_campaign_applications_base_nonneg CHECK (base_padcoins >= 0),
  CONSTRAINT padcoins_campaign_applications_final_nonneg CHECK (final_padcoins >= 0)
);

COMMENT ON TABLE padcoins_campaign_applications IS
  'Aplicaciones de campaña a reservas/earns. Controla cupos y trazabilidad.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_padcoins_campaign_applications_reserva_unique
  ON padcoins_campaign_applications (campaign_id, reserva_id)
  WHERE reserva_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_padcoins_campaign_applications_campaign_id
  ON padcoins_campaign_applications (campaign_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_padcoins_campaign_applications_user_campaign
  ON padcoins_campaign_applications (campaign_id, user_id);
