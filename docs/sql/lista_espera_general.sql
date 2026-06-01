-- Lista de espera general de torneos por sede y deporte
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

CREATE TABLE IF NOT EXISTS public.lista_espera_general (
  id serial PRIMARY KEY,
  sede_id integer NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deporte text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(sede_id, user_id, deporte)
);

CREATE INDEX IF NOT EXISTS idx_lista_espera_general_sede_id ON public.lista_espera_general (sede_id);
CREATE INDEX IF NOT EXISTS idx_lista_espera_general_user_id ON public.lista_espera_general (user_id);
CREATE INDEX IF NOT EXISTS idx_lista_espera_general_sede_deporte ON public.lista_espera_general (sede_id, deporte);
CREATE INDEX IF NOT EXISTS idx_lista_espera_general_created_at ON public.lista_espera_general (created_at DESC);

COMMENT ON TABLE public.lista_espera_general IS 'Lista de espera general de torneos por sede y deporte';
