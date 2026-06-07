-- Historial de cálculos Surge v2
CREATE TABLE IF NOT EXISTS public.surge_historial (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  deporte TEXT NOT NULL,
  ocupacion_porcentaje INTEGER NOT NULL DEFAULT 0,
  precio_calculado INTEGER NOT NULL DEFAULT 0,
  precio_base INTEGER NOT NULL DEFAULT 0,
  multiplicador NUMERIC(8, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_surge_historial_sede_created
  ON public.surge_historial (sede_id, created_at DESC);

COMMENT ON TABLE public.surge_historial IS 'Registro de precios Surge v2 calculados por sede y deporte';
