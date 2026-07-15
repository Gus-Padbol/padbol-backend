-- Comunidad (publicaciones, comentarios, reacciones, seguimiento, bloqueos, denuncias).
-- Idempotente. NO ejecuta cambios de datos históricos.
-- Orden: aplicar en Supabase ANTES del deploy que exponga /api/comunidad.
-- Sin RLS de aplicación: el Backend usa service role y aplica reglas en código.

CREATE TABLE IF NOT EXISTS public.comunidad_publicaciones (
  id BIGSERIAL PRIMARY KEY,
  autor_user_id UUID NOT NULL,
  texto TEXT NOT NULL,
  imagen_url TEXT NULL,
  sede_id INTEGER NULL,
  evento_ref TEXT NULL,
  visibilidad TEXT NOT NULL DEFAULT 'publica',
  estado TEXT NOT NULL DEFAULT 'activa',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'comunidad_publicaciones_visibilidad_chk'
      AND conrelid = 'public.comunidad_publicaciones'::regclass
  ) THEN
    ALTER TABLE public.comunidad_publicaciones
      ADD CONSTRAINT comunidad_publicaciones_visibilidad_chk
      CHECK (visibilidad IN ('publica', 'seguidores'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'comunidad_publicaciones_estado_chk'
      AND conrelid = 'public.comunidad_publicaciones'::regclass
  ) THEN
    ALTER TABLE public.comunidad_publicaciones DROP CONSTRAINT comunidad_publicaciones_estado_chk;
  END IF;
  ALTER TABLE public.comunidad_publicaciones
    ADD CONSTRAINT comunidad_publicaciones_estado_chk
    CHECK (estado IN ('activa', 'ocultada', 'eliminada'));
END $$;

CREATE INDEX IF NOT EXISTS idx_comunidad_publicaciones_feed
  ON public.comunidad_publicaciones (created_at DESC, id DESC)
  WHERE estado = 'activa';

CREATE INDEX IF NOT EXISTS idx_comunidad_publicaciones_autor
  ON public.comunidad_publicaciones (autor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comunidad_publicaciones_sede
  ON public.comunidad_publicaciones (sede_id)
  WHERE sede_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.comunidad_comentarios (
  id BIGSERIAL PRIMARY KEY,
  publicacion_id BIGINT NOT NULL REFERENCES public.comunidad_publicaciones(id) ON DELETE CASCADE,
  autor_user_id UUID NOT NULL,
  texto TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activo',
  idempotency_key TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'comunidad_comentarios_estado_chk'
      AND conrelid = 'public.comunidad_comentarios'::regclass
  ) THEN
    ALTER TABLE public.comunidad_comentarios DROP CONSTRAINT comunidad_comentarios_estado_chk;
  END IF;
  ALTER TABLE public.comunidad_comentarios
    ADD CONSTRAINT comunidad_comentarios_estado_chk
    CHECK (estado IN ('activo', 'eliminado', 'ocultado'));
END $$;

CREATE INDEX IF NOT EXISTS idx_comunidad_comentarios_pub
  ON public.comunidad_comentarios (publicacion_id, created_at ASC)
  WHERE estado = 'activo';

CREATE UNIQUE INDEX IF NOT EXISTS idx_comunidad_comentarios_idempotency
  ON public.comunidad_comentarios (publicacion_id, autor_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND estado = 'activo';

CREATE TABLE IF NOT EXISTS public.comunidad_reacciones (
  id BIGSERIAL PRIMARY KEY,
  publicacion_id BIGINT NOT NULL REFERENCES public.comunidad_publicaciones(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'like',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'comunidad_reacciones_tipo_chk'
      AND conrelid = 'public.comunidad_reacciones'::regclass
  ) THEN
    ALTER TABLE public.comunidad_reacciones
      ADD CONSTRAINT comunidad_reacciones_tipo_chk
      CHECK (tipo IN ('like'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_comunidad_reacciones_unique
  ON public.comunidad_reacciones (publicacion_id, user_id);

CREATE INDEX IF NOT EXISTS idx_comunidad_reacciones_user
  ON public.comunidad_reacciones (user_id);

CREATE TABLE IF NOT EXISTS public.comunidad_seguimientos (
  id BIGSERIAL PRIMARY KEY,
  follower_user_id UUID NOT NULL,
  following_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT comunidad_seguimientos_no_self_chk CHECK (follower_user_id <> following_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comunidad_seguimientos_unique
  ON public.comunidad_seguimientos (follower_user_id, following_user_id);

CREATE INDEX IF NOT EXISTS idx_comunidad_seguimientos_following
  ON public.comunidad_seguimientos (following_user_id);

CREATE TABLE IF NOT EXISTS public.comunidad_bloqueos (
  id BIGSERIAL PRIMARY KEY,
  blocker_user_id UUID NOT NULL,
  blocked_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT comunidad_bloqueos_no_self_chk CHECK (blocker_user_id <> blocked_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_comunidad_bloqueos_unique
  ON public.comunidad_bloqueos (blocker_user_id, blocked_user_id);

CREATE INDEX IF NOT EXISTS idx_comunidad_bloqueos_blocked
  ON public.comunidad_bloqueos (blocked_user_id);

CREATE TABLE IF NOT EXISTS public.comunidad_denuncias (
  id BIGSERIAL PRIMARY KEY,
  denunciante_user_id UUID NOT NULL,
  objeto_tipo TEXT NOT NULL,
  objeto_id BIGINT NOT NULL,
  motivo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revisada_at TIMESTAMPTZ NULL,
  revisada_por UUID NULL,
  resolucion_nota TEXT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'comunidad_denuncias_objeto_chk'
      AND conrelid = 'public.comunidad_denuncias'::regclass
  ) THEN
    ALTER TABLE public.comunidad_denuncias
      ADD CONSTRAINT comunidad_denuncias_objeto_chk
      CHECK (objeto_tipo IN ('publicacion', 'comentario'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'comunidad_denuncias_estado_chk'
      AND conrelid = 'public.comunidad_denuncias'::regclass
  ) THEN
    ALTER TABLE public.comunidad_denuncias DROP CONSTRAINT comunidad_denuncias_estado_chk;
  END IF;
  ALTER TABLE public.comunidad_denuncias
    ADD CONSTRAINT comunidad_denuncias_estado_chk
    CHECK (estado IN ('pendiente', 'revisada', 'descartada'));
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_comunidad_denuncias_activa_unique
  ON public.comunidad_denuncias (denunciante_user_id, objeto_tipo, objeto_id)
  WHERE estado = 'pendiente';

CREATE INDEX IF NOT EXISTS idx_comunidad_denuncias_estado
  ON public.comunidad_denuncias (estado, created_at DESC);

COMMENT ON TABLE public.comunidad_publicaciones IS 'Publicaciones sociales de Comunidad (texto + imagen opcional).';
COMMENT ON TABLE public.comunidad_seguimientos IS 'Relación follower → following.';
COMMENT ON TABLE public.comunidad_bloqueos IS 'Bloqueo unidireccional; no borra historial.';
COMMENT ON TABLE public.comunidad_denuncias IS 'Denuncias de contenido; trazabilidad de moderación.';
