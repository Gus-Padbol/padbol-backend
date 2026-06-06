-- Surge pricing per sede + deporte (master toggle remains sedes.surge_activo)
CREATE TABLE IF NOT EXISTS public.surge_config (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  deporte TEXT NOT NULL,
  precio_minimo INTEGER NOT NULL DEFAULT 0,
  precio_maximo INTEGER NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sede_id, deporte)
);

CREATE INDEX IF NOT EXISTS idx_surge_config_sede ON public.surge_config (sede_id);

COMMENT ON TABLE public.surge_config IS 'Precios dinámicos Surge por sede y deporte';
COMMENT ON COLUMN public.surge_config.activo IS 'Surge habilitado para este deporte en la sede (requiere sedes.surge_activo)';
