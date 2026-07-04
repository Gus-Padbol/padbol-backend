-- PadCoins V1 — migración de tablas (Padbol Match)
-- RFC: docs/RFC_PADCOINS_V1.md
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- PadCoins no es dinero.
-- PadCoins está separado de XP / liga Arena.
-- PadCoins está separado de ranking points (RP) y puntos de torneo.
-- historico_total no baja al canjear; disponible sí baja al canjear.

-- ─── 1) padcoins_saldo ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS padcoins_saldo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  disponible INTEGER NOT NULL DEFAULT 0,
  historico_total INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT padcoins_saldo_user_id_unique UNIQUE (user_id),
  CONSTRAINT padcoins_saldo_disponible_nonneg CHECK (disponible >= 0),
  CONSTRAINT padcoins_saldo_historico_total_nonneg CHECK (historico_total >= 0)
);

COMMENT ON TABLE padcoins_saldo IS
  'Saldo PadCoins por jugador. Moneda de fidelización; no es dinero. Separado de XP y RP.';
COMMENT ON COLUMN padcoins_saldo.disponible IS
  'PadCoins canjeables; baja al canjear premios.';
COMMENT ON COLUMN padcoins_saldo.historico_total IS
  'PadCoins acumuladas históricamente; no baja al canjear (progreso / nivel).';

CREATE INDEX IF NOT EXISTS idx_padcoins_saldo_user_id
  ON padcoins_saldo (user_id);

-- ─── 2) padcoins_movimientos ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS padcoins_movimientos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tipo TEXT NOT NULL,
  monto INTEGER NOT NULL,
  saldo_antes INTEGER NOT NULL,
  saldo_despues INTEGER NOT NULL,
  referencia_tipo TEXT,
  referencia_id TEXT,
  sede_id INTEGER REFERENCES sedes (id) ON DELETE SET NULL,
  descripcion TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  CONSTRAINT padcoins_movimientos_tipo_check
    CHECK (tipo IN ('earn', 'spend', 'adjust', 'reverse')),
  CONSTRAINT padcoins_movimientos_monto_nonzero
    CHECK (monto <> 0),
  CONSTRAINT padcoins_movimientos_saldo_antes_nonneg
    CHECK (saldo_antes >= 0),
  CONSTRAINT padcoins_movimientos_saldo_despues_nonneg
    CHECK (saldo_despues >= 0)
);

COMMENT ON TABLE padcoins_movimientos IS
  'Historial append-only de movimientos PadCoins. Separado de xp_transacciones.';
COMMENT ON COLUMN padcoins_movimientos.tipo IS
  'earn | spend | adjust | reverse';
COMMENT ON COLUMN padcoins_movimientos.monto IS
  'Positivo en acreditaciones; negativo en gastos/penalizaciones (convención del servicio).';
COMMENT ON COLUMN padcoins_movimientos.sede_id IS
  'Sede asociada al movimiento; FK a sedes(id) INTEGER.';

CREATE INDEX IF NOT EXISTS idx_padcoins_movimientos_user_created
  ON padcoins_movimientos (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_padcoins_movimientos_sede_created
  ON padcoins_movimientos (sede_id, created_at DESC)
  WHERE sede_id IS NOT NULL;

-- ─── 3) premios_canjeables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS premios_canjeables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id INTEGER NOT NULL REFERENCES sedes (id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  costo_padcoins INTEGER NOT NULL,
  stock_total INTEGER,
  stock_disponible INTEGER,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  fecha_inicio TIMESTAMPTZ,
  fecha_fin TIMESTAMPTZ,
  condiciones TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT premios_canjeables_costo_positivo
    CHECK (costo_padcoins > 0),
  CONSTRAINT premios_canjeables_stock_total_nonneg
    CHECK (stock_total IS NULL OR stock_total >= 0),
  CONSTRAINT premios_canjeables_stock_disponible_nonneg
    CHECK (stock_disponible IS NULL OR stock_disponible >= 0)
);

COMMENT ON TABLE premios_canjeables IS
  'Catálogo de premios canjeables por sede con costo en PadCoins (no dinero).';
COMMENT ON COLUMN premios_canjeables.costo_padcoins IS
  'Precio en PadCoins; separado de XP y ranking points.';
COMMENT ON COLUMN premios_canjeables.sede_id IS
  'FK a sedes(id) INTEGER; premios configurables por sede.';

CREATE INDEX IF NOT EXISTS idx_premios_canjeables_sede_activo
  ON premios_canjeables (sede_id, activo);

-- ─── 4) padcoins_canjes ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS padcoins_canjes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  sede_id INTEGER NOT NULL REFERENCES sedes (id) ON DELETE CASCADE,
  premio_id UUID NOT NULL REFERENCES premios_canjeables (id) ON DELETE RESTRICT,
  monto_padcoins INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  codigo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entregado_at TIMESTAMPTZ,
  entregado_por UUID,
  CONSTRAINT padcoins_canjes_estado_check
    CHECK (estado IN ('pendiente', 'aprobado', 'entregado', 'cancelado', 'vencido')),
  CONSTRAINT padcoins_canjes_monto_positivo
    CHECK (monto_padcoins > 0),
  CONSTRAINT padcoins_canjes_codigo_unique
    UNIQUE (codigo)
);

COMMENT ON TABLE padcoins_canjes IS
  'Canjes de premios por PadCoins. Cada canje debe tener movimiento spend asociado (servicio V1).';
COMMENT ON COLUMN padcoins_canjes.codigo IS
  'Código generado por backend al canjear; no por la app.';
COMMENT ON COLUMN padcoins_canjes.sede_id IS
  'FK a sedes(id) INTEGER; sede donde se canjea/entrega el premio.';

CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_user_created
  ON padcoins_canjes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_sede_estado
  ON padcoins_canjes (sede_id, estado);

CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_premio_id
  ON padcoins_canjes (premio_id);
