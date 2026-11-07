-- Rollback SEGURO: no borra edad conocida ni degrada filas con edad desconocida.
BEGIN;
DO $$
DECLARE
  v_existe boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='nations_activation_participants'
                    AND column_name='age_status') INTO v_existe;
  IF v_existe THEN
    IF EXISTS (SELECT 1 FROM public.nations_activation_participants
                WHERE age_status IS NULL OR age_status='desconocido') THEN
      RAISE EXCEPTION 'Hay participantes con edad desconocida o sin edad: resolverlos antes de quitar age_status.';
    END IF;
  END IF;
END $$;
ALTER TABLE public.nations_activation_participants DROP CONSTRAINT IF EXISTS nations_participants_age_status_consistente;
ALTER TABLE public.nations_activation_participants DROP CONSTRAINT IF EXISTS nations_participants_age_status_valido;
ALTER TABLE public.nations_activation_participants DROP COLUMN IF EXISTS age_status;
COMMIT;
