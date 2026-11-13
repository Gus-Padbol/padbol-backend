-- Preferred foot is distinct from playing hand (lateralidad/mano_preferida).
ALTER TABLE public.jugadores_perfil ADD COLUMN IF NOT EXISTS pierna_habil text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.jugadores_perfil'::regclass
      AND conname = 'jugadores_perfil_pierna_habil_check'
  ) THEN
    ALTER TABLE public.jugadores_perfil
      ADD CONSTRAINT jugadores_perfil_pierna_habil_check
      CHECK (pierna_habil IS NULL OR pierna_habil IN ('derecha','izquierda','ambas'));
  END IF;
END $$;
