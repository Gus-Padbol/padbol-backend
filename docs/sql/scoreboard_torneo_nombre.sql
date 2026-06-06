-- Agregar nombre de torneo opcional a partidos de scoreboard
ALTER TABLE scoreboard_partidos
  ADD COLUMN IF NOT EXISTS torneo_nombre TEXT;
