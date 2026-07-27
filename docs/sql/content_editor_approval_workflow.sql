-- Circuito editorial: borrador -> revisión -> aprobación -> publicación.
-- Seguro para volver a ejecutar.

CREATE TABLE IF NOT EXISTS public.content_editor_drafts (
  id BIGSERIAL PRIMARY KEY,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('hub', 'ad')),
  deporte TEXT NOT NULL,
  item_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'rejected', 'approved')),
  review_note TEXT NULL,
  updated_by UUID NULL,
  submitted_at TIMESTAMPTZ NULL,
  reviewed_by UUID NULL,
  reviewed_at TIMESTAMPTZ NULL,
  published_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (content_type, deporte, item_key)
);

CREATE INDEX IF NOT EXISTS idx_content_editor_drafts_status
ON public.content_editor_drafts (status, updated_at DESC);

COMMENT ON TABLE public.content_editor_drafts IS
  'Contenido editorial no público. Sólo una aprobación de super_admin copia payload a las tablas públicas.';

ALTER TABLE public.content_editor_drafts ENABLE ROW LEVEL SECURITY;

-- No se crean políticas públicas: lectura y escritura se realizan únicamente
-- desde el backend autenticado mediante service_role.
