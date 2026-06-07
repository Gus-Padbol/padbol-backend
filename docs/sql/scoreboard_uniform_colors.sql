-- Colores de uniforme por jugador en scoreboard (slots 1-2 por equipo)
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS color_uniforme_a1 TEXT;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS color_uniforme_a2 TEXT;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS color_uniforme_b1 TEXT;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS color_uniforme_b2 TEXT;
