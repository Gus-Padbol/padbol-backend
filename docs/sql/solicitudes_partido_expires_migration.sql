-- Vencimiento y estados ampliados para solicitudes_partido (invitaciones + solicitudes).
-- Ejecutar en Supabase SQL Editor.

ALTER TABLE public.solicitudes_partido
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE public.solicitudes_partido DROP CONSTRAINT IF EXISTS solicitudes_partido_estado_check;
ALTER TABLE public.solicitudes_partido ADD CONSTRAINT solicitudes_partido_estado_check
  CHECK (estado IN (
    'pendiente',
    'aceptado',
    'rechazado',
    'invitado',
    'expirado',
    'cancelado',
    'conflicto'
  ));

CREATE INDEX IF NOT EXISTS idx_solicitudes_partido_expires_at
  ON public.solicitudes_partido (expires_at)
  WHERE estado IN ('pendiente', 'invitado');

CREATE INDEX IF NOT EXISTS idx_solicitudes_partido_partido_estado
  ON public.solicitudes_partido (partido_id, estado);

COMMENT ON COLUMN public.solicitudes_partido.expires_at IS
  'Vencimiento de invitación/solicitud pendiente. App: 4h desde invitación o 2h antes del partido.';
