-- Lista de interés / waitlist de torneos por sede
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

CREATE TABLE IF NOT EXISTS public.torneo_interes (
  id serial PRIMARY KEY,
  sede_id integer NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deporte text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(sede_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_torneo_interes_sede_id ON public.torneo_interes (sede_id);
CREATE INDEX IF NOT EXISTS idx_torneo_interes_user_id ON public.torneo_interes (user_id);
CREATE INDEX IF NOT EXISTS idx_torneo_interes_created_at ON public.torneo_interes (created_at DESC);

COMMENT ON TABLE public.torneo_interes IS 'Usuarios interesados en torneos futuros por sede (waitlist)';
COMMENT ON COLUMN public.torneo_interes.deporte IS 'Deporte de interés opcional (padbol, tenis, etc.)';
