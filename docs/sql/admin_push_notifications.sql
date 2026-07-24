-- Historial privado y cuota semanal de notificaciones enviadas desde Admin.
-- Ejecutar una sola vez en Supabase antes de habilitar la pestaña Notifications.

CREATE TABLE IF NOT EXISTS public.admin_push_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL,
  admin_email TEXT,
  admin_role TEXT NOT NULL
    CHECK (admin_role IN ('super_admin', 'admin_nacional', 'admin_club')),
  segment JSONB NOT NULL DEFAULT '{}'::jsonb,
  segment_type TEXT NOT NULL
    CHECK (segment_type IN (
      'todos_usuarios',
      'todos_pais',
      'pais',
      'sede',
      'sede_mia',
      'deporte',
      'jugador'
    )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_push_notifications_admin_created
  ON public.admin_push_notifications (admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_push_notifications_created
  ON public.admin_push_notifications (created_at DESC);

ALTER TABLE public.admin_push_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_push_notifications FROM anon, authenticated;

COMMENT ON TABLE public.admin_push_notifications IS
  'Historial privado de notificaciones push administrativas y base para la cuota semanal.';
