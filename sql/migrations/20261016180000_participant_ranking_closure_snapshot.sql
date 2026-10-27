-- No backfill. Explicit accreditation may qualify at closure; later changes are not retroactive.
BEGIN;
CREATE TABLE public.torneo_participante_ranking_cierres (
 torneo_id bigint NOT NULL REFERENCES public.torneos(id),
 equipo_id bigint NOT NULL REFERENCES public.equipos(id),
 participantes jsonb NOT NULL CHECK(jsonb_typeof(participantes)='array'),
 closed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(torneo_id,equipo_id)
);
ALTER TABLE public.torneo_participante_ranking_cierres ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_participante_ranking_cierres FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,DELETE ON public.torneo_participante_ranking_cierres TO service_role;

CREATE FUNCTION public.freeze_participant_ranking_closure()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE e public.equipos;entries jsonb;
BEGIN
 IF NEW.estado IS DISTINCT FROM 'finalizado' OR OLD.estado='finalizado' THEN RETURN NEW;END IF;
 FOR e IN SELECT * FROM public.equipos WHERE torneo_id=NEW.id AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jugadores)='array' THEN jugadores ELSE '[]'::jsonb END) j WHERE j ? 'participante_id') ORDER BY id FOR UPDATE LOOP
  SELECT coalesce(jsonb_agg(jsonb_build_object('participante_id',x.id,'user_id',x.linked_user_id) ORDER BY x.id),'[]'::jsonb) INTO entries FROM (
   SELECT DISTINCT p.id,p.linked_user_id FROM public.torneo_participantes p
   JOIN public.torneo_participante_equipos member ON member.torneo_id=p.torneo_id AND member.participante_id=p.id AND member.equipo_id=e.id
   JOIN public.torneo_participante_acreditaciones a ON a.torneo_id=p.torneo_id AND a.participante_id=p.id AND a.user_id=p.linked_user_id AND a.estado='aprobado'
   JOIN public.torneo_homologaciones h ON h.torneo_id=p.torneo_id
   JOIN public.user_roles approver ON approver.user_id=a.resuelto_por AND approver.role='super_admin'
   JOIN public.user_roles homologator ON homologator.user_id=h.confirmado_por AND homologator.role='super_admin'
   JOIN auth.users u ON u.id=p.linked_user_id
   WHERE p.torneo_id=NEW.id AND p.ranking_oficial_elegible IS TRUE AND p.estado_vinculacion='vinculado'
    AND NEW.es_prueba IS NOT TRUE AND NEW.fipa_registration_enabled IS TRUE
    AND NEW.nivel_torneo IN('club_oficial','nacional','internacional','mundial')
    AND length(a.referencia_oficial)>=8 AND length(a.evidencia)>=20 AND length(h.referencia_oficial)>=8 AND length(h.evidencia)>=20
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.jugadores) j WHERE j->>'participante_id'=p.id::text)
    AND (e.modalidad_plantel IS DISTINCT FROM 'selecciones' OR p.linked_user_id=ANY(coalesce(e.participantes_ranking,'{}'::uuid[])))
  ) x;
  INSERT INTO public.torneo_participante_ranking_cierres(torneo_id,equipo_id,participantes) VALUES(NEW.id,e.id,entries);
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.freeze_participant_ranking_closure() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER freeze_participant_ranking_closure AFTER UPDATE OF estado ON public.torneos FOR EACH ROW EXECUTE FUNCTION public.freeze_participant_ranking_closure();

CREATE FUNCTION public.guard_participant_ranking_closure_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user IN('service_role','postgres','supabase_admin') AND OLD.participantes='[]'::jsonb AND EXISTS(SELECT 1 FROM public.torneos WHERE id=OLD.torneo_id AND es_prueba IS TRUE) THEN RETURN OLD;END IF;
 RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Closed participant eligibility is immutable';
END $$;
REVOKE ALL ON FUNCTION public.guard_participant_ranking_closure_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER guard_participant_ranking_closure_immutable BEFORE UPDATE OR DELETE ON public.torneo_participante_ranking_cierres FOR EACH ROW EXECUTE FUNCTION public.guard_participant_ranking_closure_immutable();
COMMIT;
