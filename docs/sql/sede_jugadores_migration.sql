-- MEJ-04: vinculación formal sede ↔ jugador (roster admin).
-- Idempotente. NO borra historial de reservas ni modifica tablas legacy.
-- Orden: aplicar en Supabase ANTES de usar POST /api/admin/jugadores/:userId/vincular|desvincular.
-- GET /api/admin/jugadores sigue funcionando con historial de reservas si esta tabla aún no existe.

CREATE TABLE IF NOT EXISTS public.sede_jugadores (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL,
  user_id UUID NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activo',
  origen TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NULL,
  desvinculado_at TIMESTAMPTZ NULL,
  notas TEXT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sede_jugadores_estado_chk'
      AND conrelid = 'public.sede_jugadores'::regclass
  ) THEN
    ALTER TABLE public.sede_jugadores DROP CONSTRAINT sede_jugadores_estado_chk;
  END IF;
  ALTER TABLE public.sede_jugadores
    ADD CONSTRAINT sede_jugadores_estado_chk
    CHECK (estado IN ('activo', 'inactivo'));
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sede_jugadores_origen_chk'
      AND conrelid = 'public.sede_jugadores'::regclass
  ) THEN
    ALTER TABLE public.sede_jugadores DROP CONSTRAINT sede_jugadores_origen_chk;
  END IF;
  ALTER TABLE public.sede_jugadores
    ADD CONSTRAINT sede_jugadores_origen_chk
    CHECK (origen IN ('manual', 'reserva', 'torneo', 'membresia', 'importacion'));
END $$;

-- Una sola relación activa por sede + jugador.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sede_jugadores_activa_unique
  ON public.sede_jugadores (sede_id, user_id)
  WHERE estado = 'activo';

CREATE INDEX IF NOT EXISTS idx_sede_jugadores_sede_estado
  ON public.sede_jugadores (sede_id, estado);

CREATE INDEX IF NOT EXISTS idx_sede_jugadores_user_estado
  ON public.sede_jugadores (user_id, estado);

COMMENT ON TABLE public.sede_jugadores IS
  'MEJ-04: vínculo formal admin sede↔jugador. Soft-unlink (estado=inactivo); no reemplaza historial de reservas.';
