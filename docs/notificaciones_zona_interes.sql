CREATE TABLE IF NOT EXISTS public.notificaciones_zona_interes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text,
  deporte text,
  lat float,
  lng float,
  email text,
  created_at timestamptz DEFAULT now()
);
