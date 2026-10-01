-- Medición mínima de publicidad editorial. Seguro para volver a ejecutar.
CREATE TABLE IF NOT EXISTS public.content_ad_events (
  id BIGSERIAL PRIMARY KEY,
  ad_id BIGINT NOT NULL REFERENCES public.content_ad_slots(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'click')),
  slot_key TEXT NOT NULL DEFAULT 'app_general',
  platform TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_ad_events_reporting
ON public.content_ad_events (ad_id, event_type, created_at DESC);

ALTER TABLE public.content_ad_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.content_ad_events IS
  'Eventos agregados de impresión y clic de publicidad editorial; sin datos personales.';
