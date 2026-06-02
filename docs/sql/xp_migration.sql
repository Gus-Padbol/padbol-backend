-- Sistema XP ARENA: columnas, transacciones y función sumar_xp

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liga TEXT NOT NULL DEFAULT 'INIT';

CREATE TABLE IF NOT EXISTS xp_transacciones (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  xp INTEGER NOT NULL,
  descripcion TEXT,
  referencia_id TEXT,
  xp_total_despues INTEGER,
  liga_despues TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_xp_transacciones_user
  ON xp_transacciones (user_id, created_at DESC);

ALTER TABLE partidos_abiertos
  ADD COLUMN IF NOT EXISTS resultado_json JSONB;

COMMENT ON COLUMN partidos_abiertos.resultado_json IS
  'Confirmación dual: { cargas: { userId: { equipo1, equipo2 } }, estado_confirmacion }';

-- Permitir estado en_disputa en partidos abiertos
-- (si existe CHECK constraint, ajustar manualmente en Supabase)

CREATE OR REPLACE FUNCTION sumar_xp(
  p_user_id UUID,
  p_tipo TEXT,
  p_xp INTEGER,
  p_descripcion TEXT DEFAULT NULL,
  p_referencia_id TEXT DEFAULT NULL
)
RETURNS TABLE (xp_sumado INTEGER, xp_total INTEGER, liga TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_xp_total INTEGER;
  v_liga TEXT;
BEGIN
  UPDATE jugadores_perfil
  SET xp = COALESCE(xp, 0) + p_xp
  WHERE user_id = p_user_id
  RETURNING xp INTO v_xp_total;

  IF NOT FOUND THEN
    INSERT INTO jugadores_perfil (user_id, xp, liga)
    VALUES (p_user_id, p_xp, 'INIT')
    RETURNING xp INTO v_xp_total;
  END IF;

  v_liga := CASE
    WHEN v_xp_total >= 25000 THEN 'LEGEND'
    WHEN v_xp_total >= 10000 THEN 'ELITE'
    WHEN v_xp_total >= 4000 THEN 'GOLD'
    WHEN v_xp_total >= 1500 THEN 'SILVER'
    WHEN v_xp_total >= 500 THEN 'BRONZE'
    ELSE 'INIT'
  END;

  UPDATE jugadores_perfil SET liga = v_liga WHERE user_id = p_user_id;

  INSERT INTO xp_transacciones (user_id, tipo, xp, descripcion, referencia_id, xp_total_despues, liga_despues)
  VALUES (p_user_id, p_tipo, p_xp, p_descripcion, p_referencia_id, v_xp_total, v_liga);

  RETURN QUERY SELECT p_xp, v_xp_total, v_liga;
END;
$$;

-- Logros ARENA (opcional)
CREATE TABLE IF NOT EXISTS logros (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  criterio_tipo TEXT,
  criterio_valor INTEGER,
  activo BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS logros_jugador (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  logro_id BIGINT NOT NULL REFERENCES logros(id) ON DELETE CASCADE,
  contexto JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, logro_id)
);
