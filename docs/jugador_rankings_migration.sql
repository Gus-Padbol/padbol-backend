-- Player ranking positions by scope (club / nacional / fipa). Run when ready to populate.
CREATE TABLE IF NOT EXISTS jugador_rankings (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('club', 'nacional', 'fipa')),
  deporte TEXT NOT NULL,
  categoria TEXT NOT NULL,
  posicion INTEGER NOT NULL CHECK (posicion > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, tipo, deporte, categoria)
);

CREATE INDEX IF NOT EXISTS idx_jugador_rankings_user ON jugador_rankings (user_id);

COMMENT ON TABLE jugador_rankings IS 'Earned ranking positions per player, scope, sport and category';
