-- Invitaciones/solicitudes de equipos_usuario (MEJ invitaciones equipo).
-- Idempotente. NO ejecuta cambios de datos históricos más allá de defaults.
-- Orden: aplicar en Supabase ANTES del deploy del backend.
--
-- Reutiliza equipos_jugadores (invitación = fila). Agrega:
--   tipo: invitacion | solicitud
--   expires_at
--   visibilidad del equipo: abierto | cerrado
-- Estados ampliados: pendiente | aceptado | rechazado | cancelado | vencido

ALTER TABLE public.equipos_usuario
  ADD COLUMN IF NOT EXISTS visibilidad TEXT NOT NULL DEFAULT 'cerrado';

COMMENT ON COLUMN public.equipos_usuario.visibilidad IS
  'abierto = admite solicitudes de ingreso; cerrado = solo invitación del capitán.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'equipos_usuario_visibilidad_chk'
      AND conrelid = 'public.equipos_usuario'::regclass
  ) THEN
    ALTER TABLE public.equipos_usuario
      ADD CONSTRAINT equipos_usuario_visibilidad_chk
      CHECK (visibilidad IN ('abierto', 'cerrado'));
  END IF;
END $$;

ALTER TABLE public.equipos_jugadores
  ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'invitacion',
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

COMMENT ON COLUMN public.equipos_jugadores.tipo IS
  'invitacion (capitán → jugador) | solicitud (jugador → equipo abierto).';
COMMENT ON COLUMN public.equipos_jugadores.estado IS
  'pendiente | aceptado | rechazado | cancelado | vencido';
COMMENT ON COLUMN public.equipos_jugadores.expires_at IS
  'Vencimiento de invitaciones/solicitudes pendientes.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'equipos_jugadores_tipo_chk'
      AND conrelid = 'public.equipos_jugadores'::regclass
  ) THEN
    ALTER TABLE public.equipos_jugadores
      ADD CONSTRAINT equipos_jugadores_tipo_chk
      CHECK (tipo IN ('invitacion', 'solicitud'));
  END IF;
END $$;

-- Ampliar estados (drop+recreate idempotente si el check anterior era más estricto).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'equipos_jugadores_estado_chk'
      AND conrelid = 'public.equipos_jugadores'::regclass
  ) THEN
    ALTER TABLE public.equipos_jugadores DROP CONSTRAINT equipos_jugadores_estado_chk;
  END IF;
  ALTER TABLE public.equipos_jugadores
    ADD CONSTRAINT equipos_jugadores_estado_chk
    CHECK (estado IN ('pendiente', 'aceptado', 'rechazado', 'cancelado', 'vencido'));
END $$;

CREATE INDEX IF NOT EXISTS idx_equipos_jugadores_equipo_estado
  ON public.equipos_jugadores (equipo_id, estado);

CREATE INDEX IF NOT EXISTS idx_equipos_jugadores_user_estado
  ON public.equipos_jugadores (user_id, estado)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_equipos_jugadores_email_estado
  ON public.equipos_jugadores (lower(email), estado);

CREATE INDEX IF NOT EXISTS idx_equipos_jugadores_expires_pending
  ON public.equipos_jugadores (expires_at)
  WHERE estado = 'pendiente' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_equipos_usuario_torneo
  ON public.equipos_usuario (torneo_id)
  WHERE torneo_id IS NOT NULL;

-- Un solo pendiente activo por equipo+email (refuerzo; UNIQUE(equipo_id,email) ya existe).
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipos_jugadores_pending_unique
  ON public.equipos_jugadores (equipo_id, lower(email))
  WHERE estado = 'pendiente';
