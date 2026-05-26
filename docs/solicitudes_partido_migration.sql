-- Run in Supabase SQL Editor (partidos_abiertos.id is BIGINT)

CREATE TABLE IF NOT EXISTS public.solicitudes_partido (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  partido_id bigint REFERENCES public.partidos_abiertos(id) ON DELETE CASCADE,
  solicitante_id uuid NOT NULL,
  estado text DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aceptado', 'rechazado')),
  created_at timestamptz DEFAULT now(),
  UNIQUE (partido_id, solicitante_id)
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_partido_partido_id ON public.solicitudes_partido(partido_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_partido_solicitante_id ON public.solicitudes_partido(solicitante_id);

-- Invitaciones del capitán (estado invitado)
ALTER TABLE public.solicitudes_partido DROP CONSTRAINT IF EXISTS solicitudes_partido_estado_check;
ALTER TABLE public.solicitudes_partido ADD CONSTRAINT solicitudes_partido_estado_check
  CHECK (estado IN ('pendiente', 'aceptado', 'rechazado', 'invitado'));
