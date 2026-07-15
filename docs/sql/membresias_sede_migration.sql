-- Membresías por sede (planes + membresías jugador + usos de reservas incluidas).
-- Idempotente. NO migra ni borra la tabla legacy public.membresias (catálogo nativa gratuito/premium/elite).
-- Orden: aplicar en Supabase ANTES del deploy que use /api/admin/membresias y beneficios en reservas.
-- Renovación automática de cobro: NO implementada (columna reservada / documentada).
-- PadCoins: no se toca en esta migración.

CREATE TABLE IF NOT EXISTS public.membresia_planes (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  descripcion TEXT NULL,
  precio NUMERIC(12, 2) NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT 'ARS',
  duracion_tipo TEXT NOT NULL DEFAULT 'mensual',
  duracion_dias INTEGER NULL,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  cupo INTEGER NULL,
  vigencia_desde TIMESTAMPTZ NULL,
  vigencia_hasta TIMESTAMPTZ NULL,
  renovacion_automatica BOOLEAN NOT NULL DEFAULT FALSE,
  beneficios JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'membresia_planes_duracion_tipo_chk'
      AND conrelid = 'public.membresia_planes'::regclass
  ) THEN
    ALTER TABLE public.membresia_planes
      ADD CONSTRAINT membresia_planes_duracion_tipo_chk
      CHECK (duracion_tipo IN ('mensual', 'trimestral', 'semestral', 'anual', 'dias'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_membresia_planes_sede_activo
  ON public.membresia_planes (sede_id, activo);

CREATE TABLE IF NOT EXISTS public.membresias_sede (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  email TEXT NULL,
  sede_id INTEGER NOT NULL,
  plan_id BIGINT NOT NULL REFERENCES public.membresia_planes(id),
  estado TEXT NOT NULL DEFAULT 'pendiente',
  origen TEXT NOT NULL DEFAULT 'manual',
  inicio TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vencimiento TIMESTAMPTZ NOT NULL,
  renovacion_automatica BOOLEAN NOT NULL DEFAULT FALSE,
  notas TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NULL,
  cancelada_at TIMESTAMPTZ NULL,
  suspendida_at TIMESTAMPTZ NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'membresias_sede_estado_chk'
      AND conrelid = 'public.membresias_sede'::regclass
  ) THEN
    ALTER TABLE public.membresias_sede DROP CONSTRAINT membresias_sede_estado_chk;
  END IF;
  ALTER TABLE public.membresias_sede
    ADD CONSTRAINT membresias_sede_estado_chk
    CHECK (estado IN ('pendiente', 'activa', 'suspendida', 'vencida', 'cancelada'));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'membresias_sede_origen_chk'
      AND conrelid = 'public.membresias_sede'::regclass
  ) THEN
    ALTER TABLE public.membresias_sede
      ADD CONSTRAINT membresias_sede_origen_chk
      CHECK (origen IN ('manual', 'pago', 'promocion'));
  END IF;
END $$;

-- Como máximo una membresía activa por jugador+sede.
CREATE UNIQUE INDEX IF NOT EXISTS idx_membresias_sede_activa_unique
  ON public.membresias_sede (user_id, sede_id)
  WHERE estado = 'activa';

CREATE INDEX IF NOT EXISTS idx_membresias_sede_user
  ON public.membresias_sede (user_id, estado);

CREATE INDEX IF NOT EXISTS idx_membresias_sede_sede_estado
  ON public.membresias_sede (sede_id, estado);

CREATE INDEX IF NOT EXISTS idx_membresias_sede_vencimiento
  ON public.membresias_sede (vencimiento)
  WHERE estado = 'activa';

CREATE TABLE IF NOT EXISTS public.membresia_usos_reserva (
  id BIGSERIAL PRIMARY KEY,
  membresia_id BIGINT NOT NULL REFERENCES public.membresias_sede(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  sede_id INTEGER NOT NULL,
  reserva_id BIGINT NULL,
  periodo_key TEXT NOT NULL,
  beneficio TEXT NOT NULL,
  detalle JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_membresia_usos_reserva_idempotent
  ON public.membresia_usos_reserva (reserva_id)
  WHERE reserva_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_membresia_usos_periodo
  ON public.membresia_usos_reserva (membresia_id, periodo_key, beneficio);

COMMENT ON TABLE public.membresia_planes IS 'Planes de membresía configurables por sede.';
COMMENT ON TABLE public.membresias_sede IS 'Membresía de un jugador en una sede (historial conservado).';
COMMENT ON TABLE public.membresia_usos_reserva IS 'Consumo de beneficios reales (p.ej. reserva incluida) por período; idempotente por reserva_id.';
COMMENT ON COLUMN public.membresia_planes.renovacion_automatica IS 'Flag de producto; cobro recurrente NO implementado todavía.';
COMMENT ON COLUMN public.membresia_planes.beneficios IS
  'JSON: descuento_porcentual (0-100), reservas_incluidas_por_periodo (int), prioridad_horas (int informativo), cancelacion_horas_extra (int informativo).';
