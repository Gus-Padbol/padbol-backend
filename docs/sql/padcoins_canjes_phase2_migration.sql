-- PadCoins — Fase 2: beneficios visuales, límites y vencimiento de canjes
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Orden recomendado:
-- 1) Este archivo (premios_canjeables + padcoins_canjes)
-- 2) Verificar que padcoins_v1_migration.sql ya esté aplicado

-- ─── premios_canjeables: imagen y límites ───────────────────────────────────

ALTER TABLE premios_canjeables
  ADD COLUMN IF NOT EXISTS imagen_url TEXT,
  ADD COLUMN IF NOT EXISTS limite_usuario_cantidad INTEGER,
  ADD COLUMN IF NOT EXISTS limite_usuario_periodo TEXT,
  ADD COLUMN IF NOT EXISTS limite_global_cantidad INTEGER,
  ADD COLUMN IF NOT EXISTS limite_global_periodo TEXT,
  ADD COLUMN IF NOT EXISTS canje_validez_dias INTEGER;

COMMENT ON COLUMN premios_canjeables.imagen_url IS
  'URL opcional de imagen del beneficio. Si es null, el backend usa fallback visual.';
COMMENT ON COLUMN premios_canjeables.limite_usuario_cantidad IS
  'Máximo de canjes por jugador en el período configurado. null/0 = sin límite.';
COMMENT ON COLUMN premios_canjeables.limite_usuario_periodo IS
  'Período del límite por jugador: dia | semana | mes | total.';
COMMENT ON COLUMN premios_canjeables.limite_global_cantidad IS
  'Máximo global de canjes del beneficio en la sede/período. null/0 = sin límite.';
COMMENT ON COLUMN premios_canjeables.limite_global_periodo IS
  'Período del límite global: dia | semana | mes | total.';
COMMENT ON COLUMN premios_canjeables.canje_validez_dias IS
  'Días de validez del canje pendiente/aprobado. null = default backend (30).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'premios_canjeables_limite_usuario_nonneg'
  ) THEN
    ALTER TABLE premios_canjeables
      ADD CONSTRAINT premios_canjeables_limite_usuario_nonneg
      CHECK (limite_usuario_cantidad IS NULL OR limite_usuario_cantidad >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'premios_canjeables_limite_global_nonneg'
  ) THEN
    ALTER TABLE premios_canjeables
      ADD CONSTRAINT premios_canjeables_limite_global_nonneg
      CHECK (limite_global_cantidad IS NULL OR limite_global_cantidad >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'premios_canjeables_canje_validez_pos'
  ) THEN
    ALTER TABLE premios_canjeables
      ADD CONSTRAINT premios_canjeables_canje_validez_pos
      CHECK (canje_validez_dias IS NULL OR canje_validez_dias > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'premios_canjeables_limite_usuario_periodo_check'
  ) THEN
    ALTER TABLE premios_canjeables
      ADD CONSTRAINT premios_canjeables_limite_usuario_periodo_check
      CHECK (
        limite_usuario_periodo IS NULL
        OR limite_usuario_periodo IN ('dia', 'semana', 'mes', 'total')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'premios_canjeables_limite_global_periodo_check'
  ) THEN
    ALTER TABLE premios_canjeables
      ADD CONSTRAINT premios_canjeables_limite_global_periodo_check
      CHECK (
        limite_global_periodo IS NULL
        OR limite_global_periodo IN ('dia', 'semana', 'mes', 'total')
      );
  END IF;
END $$;

-- ─── padcoins_canjes: vencimiento y aprobación ──────────────────────────────

ALTER TABLE padcoins_canjes
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS aprobado_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS aprobado_por UUID,
  ADD COLUMN IF NOT EXISTS vencido_at TIMESTAMPTZ;

COMMENT ON COLUMN padcoins_canjes.expires_at IS
  'Fecha límite para retirar el canje en estado pendiente/aprobado.';
COMMENT ON COLUMN padcoins_canjes.aprobado_at IS
  'Marca de tiempo cuando admin aprueba el canje antes de entrega.';
COMMENT ON COLUMN padcoins_canjes.aprobado_por IS
  'Usuario admin que aprobó el canje.';
COMMENT ON COLUMN padcoins_canjes.vencido_at IS
  'Marca de tiempo cuando el canje vence y se devuelven PadCoins.';

CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_expires_at_pendiente
  ON padcoins_canjes (expires_at)
  WHERE estado IN ('pendiente', 'aprobado') AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_codigo
  ON padcoins_canjes (codigo);

CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_premio_created
  ON padcoins_canjes (premio_id, created_at DESC);

-- Backfill opcional de expires_at para canjes históricos pendientes/aprobados sin fecha
UPDATE padcoins_canjes
SET expires_at = created_at + INTERVAL '30 days'
WHERE expires_at IS NULL
  AND estado IN ('pendiente', 'aprobado');
