-- Nivel externo declarado por el jugador.
-- La categoría Padbol Match es siempre la que habilita las inscripciones;
-- esta información únicamente conserva el antecedente y su respaldo.

CREATE TABLE IF NOT EXISTS public.jugador_nivel_externo (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deporte TEXT NOT NULL DEFAULT 'padel',
  plataforma TEXT NOT NULL,
  puntuacion TEXT NOT NULL,
  categoria_inicial TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'declarado',
  evidencia_storage_path TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT jugador_nivel_externo_deporte_check CHECK (deporte IN ('padel')),
  CONSTRAINT jugador_nivel_externo_plataforma_check CHECK (plataforma IN ('playtomic', 'otra')),
  CONSTRAINT jugador_nivel_externo_estado_check CHECK (estado IN ('declarado', 'validado', 'ajustado', 'en_revision')),
  CONSTRAINT jugador_nivel_externo_user_deporte_unique UNIQUE (user_id, deporte)
);

CREATE INDEX IF NOT EXISTS jugador_nivel_externo_estado_idx
  ON public.jugador_nivel_externo (deporte, estado);

ALTER TABLE public.jugador_nivel_externo ENABLE ROW LEVEL SECURITY;

-- El backend opera con service role. No se expone acceso directo desde el cliente.

INSERT INTO storage.buckets (id, name, public)
VALUES ('nivel-externo-evidencias', 'nivel-externo-evidencias', false)
ON CONFLICT (id) DO UPDATE SET public = false;
