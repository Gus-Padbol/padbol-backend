-- Ownership/provenance for the isolated Nations 57 contingency scoreboard.
-- Official tournament markers keep this column NULL.
ALTER TABLE public.scoreboard_partidos
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid;

CREATE INDEX IF NOT EXISTS scoreboard_partidos_created_by_user_id_idx
  ON public.scoreboard_partidos (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
