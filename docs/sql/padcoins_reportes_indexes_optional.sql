-- PadCoins reportes operativos — índices opcionales (idempotente).
-- NO obligatorio para desplegar: los índices de padcoins_v1_migration ya cubren
-- (sede_id, created_at) en movimientos y (sede_id, estado) en canjes.
-- Aplicar solo si los reportes por rango amplio se vuelven lentos.
--
-- Impacto esperado: acelera listados/CSV filtrados por sede+fecha.
-- No modifica datos ni contabilidad.

CREATE INDEX IF NOT EXISTS idx_padcoins_movimientos_sede_created_desc
  ON public.padcoins_movimientos (sede_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_sede_created_desc
  ON public.padcoins_canjes (sede_id, created_at DESC);

-- Opcional: filtros por premio en reportes de canjes
CREATE INDEX IF NOT EXISTS idx_padcoins_canjes_premio_created
  ON public.padcoins_canjes (premio_id, created_at DESC);
