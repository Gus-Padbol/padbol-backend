-- Ownership for isolated Nations 57 contingency scoreboards.
-- Deliberately additive and separate from the shared scoreboard_partidos read model.
CREATE TABLE IF NOT EXISTS public.scoreboard_contingency_owners (
  scoreboard_id uuid PRIMARY KEY REFERENCES public.scoreboard_partidos(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scoreboard_contingency_owners_user_idx
  ON public.scoreboard_contingency_owners (user_id);
