-- Preferencias de notificaciones push elegidas por cada usuario.
-- Ejecutar una sola vez en Supabase antes de habilitar los interruptores móviles.

CREATE TABLE IF NOT EXISTS public.push_notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  transactional_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  marketing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.push_notification_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.push_notification_preferences FROM anon, authenticated;
GRANT ALL ON public.push_notification_preferences TO service_role;

COMMENT ON TABLE public.push_notification_preferences IS
  'Preferencias privadas de notificaciones transaccionales y promocionales por usuario.';
