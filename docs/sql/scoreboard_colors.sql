-- Colores configurables por equipo en scoreboard
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS color_a text DEFAULT '#1a3a6e';
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS color_b text DEFAULT '#6e1a1a';
