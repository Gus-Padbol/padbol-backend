-- In-app notifications for padbol-match-native.
-- Run in Supabase SQL Editor.
--
-- Producción puede existir sin data JSONB (metadata en link TEXT).
-- Ver docs/sql/notificaciones_data_column_migration.sql para agregar data.

CREATE TABLE IF NOT EXISTS public.notificaciones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  mensaje TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  link TEXT,
  leida BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notificaciones_user_created
  ON public.notificaciones (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notificaciones_user_unread
  ON public.notificaciones (user_id)
  WHERE leida = FALSE;

COMMENT ON TABLE public.notificaciones IS 'In-app notification inbox per user (partidos, reservas, reseñas, sistema).';
