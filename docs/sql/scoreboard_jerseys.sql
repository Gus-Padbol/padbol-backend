-- Jersey numbers per player slot on scoreboard matches
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_a1 INTEGER DEFAULT 1;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_a2 INTEGER DEFAULT 2;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_a3 INTEGER DEFAULT 3;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_a4 INTEGER DEFAULT 4;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_b1 INTEGER DEFAULT 1;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_b2 INTEGER DEFAULT 2;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_b3 INTEGER DEFAULT 3;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS jersey_b4 INTEGER DEFAULT 4;
