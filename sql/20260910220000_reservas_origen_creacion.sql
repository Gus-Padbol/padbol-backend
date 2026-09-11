-- Candidate only. Apply to QA before the corresponding self-service writers.
-- Historical reservations remain NULL; no retroactive classification or billing.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.reservas ADD COLUMN IF NOT EXISTS origen_creacion text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='reservas'
      AND column_name='origen_creacion' AND data_type='text' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'reservas_origen_creacion_schema_requires_review';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.reservas'::regclass AND conname='reservas_origen_creacion_check') THEN
    ALTER TABLE public.reservas ADD CONSTRAINT reservas_origen_creacion_check
      CHECK (origen_creacion IS NULL OR origen_creacion IN ('checkout_jugador_v1','encuentro_jugador_v1'));
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.reservas'::regclass AND conname='reservas_origen_creacion_check'
      AND convalidated AND pg_get_constraintdef(oid) =
      $expected$CHECK (((origen_creacion IS NULL) OR (origen_creacion = ANY (ARRAY['checkout_jugador_v1'::text, 'encuentro_jugador_v1'::text]))))$expected$) THEN
    RAISE EXCEPTION 'reservas_origen_creacion_check_requires_review';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.proteger_reserva_origen_creacion()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.origen_creacion IS DISTINCT FROM OLD.origen_creacion THEN
      RAISE EXCEPTION 'reserva_creation_origin_is_immutable' USING ERRCODE='42501';
    END IF;
    -- Reassignment preserves the existing admin operation, but invalidates
    -- attribution to the original booking player/venue. No copied eligibility.
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.sede_id IS DISTINCT FROM OLD.sede_id THEN
      NEW.origen_creacion := NULL;
    END IF;
  ELSIF NEW.origen_creacion IS NOT NULL THEN
    -- Request bodies and direct authenticated/anon DB writes cannot stamp origin.
    -- Existing backend clients use service_role or the trusted PostgreSQL role.
    IF current_user NOT IN ('service_role','postgres','supabase_admin') THEN
      RAISE EXCEPTION 'reserva_creation_origin_requires_server' USING ERRCODE='42501';
    END IF;
    IF NEW.user_id IS NULL OR NEW.sede_id IS NULL THEN
      RAISE EXCEPTION 'reserva_creation_origin_requires_owner_and_venue' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS proteger_reserva_origen_creacion ON public.reservas;
CREATE TRIGGER proteger_reserva_origen_creacion
BEFORE INSERT OR UPDATE ON public.reservas
FOR EACH ROW EXECUTE FUNCTION public.proteger_reserva_origen_creacion();
COMMIT;
