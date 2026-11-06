-- Rollback SEGURO: no borra edad conocida ni degrada filas con edad desconocida.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.nations_activation_participants WHERE age_status='desconocido') THEN
    RAISE EXCEPTION 'Hay participantes con edad desconocida: resolverlos antes de quitar age_status.';
  END IF;
END $$;
ALTER TABLE public.nations_activation_participants DROP CONSTRAINT IF EXISTS nations_participants_age_status_consistente;
ALTER TABLE public.nations_activation_participants DROP CONSTRAINT IF EXISTS nations_participants_age_status_valido;
ALTER TABLE public.nations_activation_participants DROP COLUMN IF EXISTS age_status;
COMMIT;
