-- PadCoins — idempotencia segura sin romper datos históricos
-- Esta versión evita fallar por canjes/movimientos viejos duplicados.
-- No borra ni modifica datos existentes.

-- ─── 1) Metadata JSONB para trazabilidad extendida ──────────────────────────

ALTER TABLE padcoins_movimientos
  ADD COLUMN IF NOT EXISTS metadata JSONB;

COMMENT ON COLUMN padcoins_movimientos.metadata IS
  'Trazabilidad: source_type, source_id, action, campaign_id, calculation_detail, source_key.';

-- ─── 2) Índices únicos seguros para movimientos nuevos con source_key ───────
-- Desde el nuevo backend, cada movimiento relevante debe traer metadata.source_key.
-- Esto bloquea duplicaciones nuevas sin depender de referencias históricas viejas.

CREATE UNIQUE INDEX IF NOT EXISTS idx_padcoins_movimientos_source_key_unique
  ON padcoins_movimientos ((metadata->>'source_key'))
  WHERE metadata IS NOT NULL
    AND metadata ? 'source_key'
    AND metadata->>'source_key' IS NOT NULL;

-- ─── 3) Índices por origen que no deberían romper históricos ────────────────

CREATE UNIQUE INDEX IF NOT EXISTS idx_padcoins_movimientos_reserva_earn_unique
  ON padcoins_movimientos (referencia_tipo, referencia_id)
  WHERE referencia_id IS NOT NULL
    AND referencia_tipo = 'reserva'
    AND tipo = 'earn';

CREATE UNIQUE INDEX IF NOT EXISTS idx_padcoins_movimientos_logro_earn_unique
  ON padcoins_movimientos (referencia_tipo, referencia_id)
  WHERE referencia_id IS NOT NULL
    AND referencia_tipo IN ('logro', 'logro_desbloqueado')
    AND tipo = 'earn';

CREATE UNIQUE INDEX IF NOT EXISTS idx_padcoins_movimientos_penalizacion_unique
  ON padcoins_movimientos (referencia_tipo, referencia_id)
  WHERE referencia_id IS NOT NULL
    AND referencia_tipo = 'penalizacion'
    AND tipo = 'spend';

-- ─── 4) Canjes nuevos: protección desde el momento de ejecutar esta migración ─
-- Hay canjes históricos duplicados, por eso NO se puede crear un índice global.
-- Creamos un índice parcial solo para canjes creados desde ahora en adelante.

DO $$
DECLARE
  cutoff timestamptz := now();
  sql text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_padcoins_canjes_user_premio_pending_future_unique'
  ) THEN
    sql := format(
      'CREATE UNIQUE INDEX idx_padcoins_canjes_user_premio_pending_future_unique
       ON padcoins_canjes (user_id, premio_id)
       WHERE estado IN (''pendiente'', ''aprobado'')
         AND created_at >= %L',
      cutoff
    );

    EXECUTE sql;
  END IF;
END $$;

-- ─── 5) Campañas ────────────────────────────────────────────────────────────
-- Ya debería existir desde la migración de campañas:
-- idx_padcoins_campaign_applications_reserva_unique
