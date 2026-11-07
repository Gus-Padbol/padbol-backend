-- Edad explícita: 'adulto' | 'menor' | 'desconocido'. No se infiere adultez por minor=false.
BEGIN;

ALTER TABLE public.nations_activation_participants
  ADD COLUMN IF NOT EXISTS age_status text;

-- Backfill HONESTO: minor=true prueba menor; minor=false NO prueba adultez => desconocido.
UPDATE public.nations_activation_participants
   SET age_status = CASE WHEN minor THEN 'menor' ELSE 'desconocido' END
 WHERE age_status IS NULL;

ALTER TABLE public.nations_activation_participants
  ALTER COLUMN age_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='nations_participants_age_status_valido') THEN
    ALTER TABLE public.nations_activation_participants
      ADD CONSTRAINT nations_participants_age_status_valido
      CHECK (age_status IN ('adulto','menor','desconocido'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='nations_participants_age_status_consistente') THEN
    ALTER TABLE public.nations_activation_participants
      ADD CONSTRAINT nations_participants_age_status_consistente
      CHECK (
        (age_status='menor' AND minor = true)
        OR (age_status IN ('adulto','desconocido') AND minor = false)
      );
  END IF;
END $$;

COMMIT;
