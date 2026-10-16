-- Guarded rollback: refuses to erase any participant/claim/enrollment/operation data.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.referencias_plantel_general(bigint,jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'Revert dependent generic selection/Nations trigger migrations before removing participant registry';END IF;
 IF to_regclass('public.torneo_participante_ranking_cierres') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.torneo_participante_ranking_cierres) THEN RAISE EXCEPTION 'Closed eligibility audit data must be preserved';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.torneo_participantes) OR EXISTS(SELECT 1 FROM public.torneo_participante_vinculaciones)
 OR EXISTS(SELECT 1 FROM public.torneo_participante_equipos) OR EXISTS(SELECT 1 FROM public.torneo_participante_operaciones)
 THEN RAISE EXCEPTION 'Rollback requires reviewed participant data migration; no data deleted';END IF;
 IF to_regclass('public.torneo_participante_acreditaciones') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.torneo_participante_acreditaciones) OR EXISTS(SELECT 1 FROM public.torneo_homologaciones) THEN RAISE EXCEPTION 'Official review audit data must be preserved';END IF;
 END IF;
END $guard$;
DROP TRIGGER IF EXISTS freeze_participant_ranking_closure ON public.torneos;
DROP TABLE IF EXISTS public.torneo_participante_ranking_cierres;
DROP FUNCTION IF EXISTS public.freeze_participant_ranking_closure();
DROP FUNCTION IF EXISTS public.guard_participant_ranking_closure_immutable();
DROP TRIGGER IF EXISTS guard_participant_ranking_accreditation ON public.torneo_participantes;
DROP FUNCTION IF EXISTS public.guard_participant_ranking_accreditation();
DROP FUNCTION IF EXISTS public.gestionar_acreditacion_participante(bigint,uuid,text,jsonb);
DROP TABLE IF EXISTS public.torneo_participante_acreditaciones,public.torneo_homologaciones;
DROP TRIGGER guard_tournament_participant_roster ON public.equipos;
DROP FUNCTION public.guard_tournament_participant_roster();
DROP FUNCTION public.participante_plantel_congelado(uuid);
DROP FUNCTION public.gestionar_participantes_torneo(bigint,uuid,text,jsonb);
DROP TABLE public.torneo_participante_operaciones;
DROP TABLE public.torneo_participante_vinculaciones;
DROP TABLE public.torneo_participante_equipos;
DROP TABLE public.torneo_participantes;
COMMIT;
