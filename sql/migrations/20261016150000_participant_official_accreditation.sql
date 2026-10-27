-- Explicit manual decisions, separate from guest creation/linking. No points writes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.torneo_homologaciones (
 torneo_id bigint PRIMARY KEY REFERENCES public.torneos(id) ON DELETE CASCADE,
 referencia_oficial text NOT NULL CHECK(length(trim(referencia_oficial)) BETWEEN 8 AND 1000),
 evidencia text NOT NULL CHECK(length(trim(evidencia)) BETWEEN 20 AND 4000),
 confirmado_por uuid NOT NULL REFERENCES auth.users(id), confirmado_at timestamptz NOT NULL DEFAULT now(),
 requisitos_snapshot jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.torneo_participante_acreditaciones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), torneo_id bigint NOT NULL, participante_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES auth.users(id), estado text NOT NULL DEFAULT 'pendiente' CHECK(estado IN('pendiente','aprobado','rechazado')),
 referencia_oficial text, evidencia text, resuelto_por uuid REFERENCES auth.users(id), resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(participante_id,user_id), FOREIGN KEY(torneo_id,participante_id) REFERENCES public.torneo_participantes(torneo_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS torneo_participante_acreditaciones_torneo_idx ON public.torneo_participante_acreditaciones(torneo_id,estado);
ALTER TABLE public.torneo_homologaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.torneo_participante_acreditaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.torneo_homologaciones,public.torneo_participante_acreditaciones FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.torneo_homologaciones,public.torneo_participante_acreditaciones TO service_role;
ALTER TABLE public.torneo_participantes DROP CONSTRAINT IF EXISTS torneo_participantes_ranking_oficial_elegible_check;
CREATE OR REPLACE FUNCTION public.guard_participant_ranking_accreditation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $guard$
BEGIN
 IF NEW.ranking_oficial_elegible AND (TG_OP='INSERT' OR OLD.ranking_oficial_elegible IS DISTINCT FROM NEW.ranking_oficial_elegible OR OLD.linked_user_id IS DISTINCT FROM NEW.linked_user_id) THEN
  IF NOT EXISTS(SELECT 1 FROM public.torneo_participante_acreditaciones a JOIN public.torneo_homologaciones h ON h.torneo_id=a.torneo_id JOIN public.user_roles r ON r.user_id=a.resuelto_por JOIN public.torneos t ON t.id=a.torneo_id
   WHERE a.participante_id=NEW.id AND a.user_id=NEW.linked_user_id AND a.estado='aprobado' AND r.role='super_admin' AND t.es_prueba IS DISTINCT FROM true AND coalesce((to_jsonb(t)->>'fipa_registration_enabled')::boolean,false))
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Official eligibility requires a verified manual accreditation';END IF;
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION public.guard_participant_ranking_accreditation() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS guard_participant_ranking_accreditation ON public.torneo_participantes;
CREATE TRIGGER guard_participant_ranking_accreditation BEFORE INSERT OR UPDATE OF ranking_oficial_elegible,linked_user_id ON public.torneo_participantes FOR EACH ROW EXECUTE FUNCTION public.guard_participant_ranking_accreditation();

CREATE OR REPLACE FUNCTION public.gestionar_acreditacion_participante(p_torneo_id bigint,p_actor_id uuid,p_accion text,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE t public.torneos;r public.user_roles;p public.torneo_participantes;a public.torneo_participante_acreditaciones;h public.torneo_homologaciones;
 op public.torneo_participante_operaciones;profile public.jugadores_perfil;req uuid;receipt jsonb;fields jsonb;key text;ref text;evidence text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Authenticated account required';END IF;
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Tournament missing';END IF;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor_id;
 IF p_accion NOT IN('homologar','solicitar','resolver') OR p_accion IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid accreditation action';END IF;
 IF p_accion IN('homologar','resolver') AND r.role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Super administrator review required';END IF;
 BEGIN req:=(p_payload->>'request_id')::uuid;EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request UUID required';END;
 IF req IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request UUID required';END IF;
 SELECT * INTO op FROM public.torneo_participante_operaciones WHERE torneo_id=t.id AND request_id=req;
 IF FOUND THEN
  IF op.actor_id<>p_actor_id OR op.accion<>'acreditacion_'||p_accion OR op.payload<>p_payload THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Request identity conflict';END IF;
  RETURN jsonb_set(op.receipt,'{status}','"idempotent"');
 END IF;
 IF p_accion='homologar' THEN
  ref:=trim(coalesce(p_payload->>'referencia_oficial',''));evidence:=trim(coalesce(p_payload->>'evidencia',''));
  IF t.es_prueba IS TRUE OR coalesce(to_jsonb(t)->>'nivel_torneo','') NOT IN('club_oficial','nacional','internacional','mundial') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Event not configured for official FIPA review';END IF;
  IF length(ref) NOT BETWEEN 8 AND 1000 OR length(evidence) NOT BETWEEN 20 AND 4000 OR p_payload->>'confirmar_evento_oficial' IS DISTINCT FROM 'true' OR p_payload->>'confirmar_requisitos' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Official event reference and explicit verified review required';END IF;
  IF NOT coalesce((to_jsonb(t)->>'fipa_registration_enabled')::boolean,false) THEN
   IF p_payload->>'habilitar_inscripcion_fipa' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Explicit FIPA registration enablement required';END IF;
   UPDATE public.torneos SET fipa_registration_enabled=true WHERE id=t.id RETURNING * INTO t;
  END IF;
  fields:=coalesce(nullif(to_jsonb(t)->'fipa_required_fields','null'::jsonb),'[]'::jsonb);
  IF jsonb_typeof(fields)<>'array' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Event required fields must be configured as an array';END IF;
  INSERT INTO public.torneo_homologaciones(torneo_id,referencia_oficial,evidencia,confirmado_por,requisitos_snapshot) VALUES(t.id,ref,evidence,p_actor_id,fields)
   ON CONFLICT(torneo_id) DO UPDATE SET referencia_oficial=EXCLUDED.referencia_oficial,evidencia=EXCLUDED.evidencia,confirmado_por=p_actor_id,confirmado_at=now(),requisitos_snapshot=EXCLUDED.requisitos_snapshot RETURNING * INTO h;
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','updated','homologacion',jsonb_build_object('estado','aprobada','referencia_oficial',h.referencia_oficial,'fipa_registration_enabled',true));
 ELSIF p_accion='solicitar' THEN
  SELECT * INTO p FROM public.torneo_participantes WHERE id=(p_payload->>'participante_id')::uuid AND torneo_id=t.id FOR UPDATE;
  IF NOT FOUND OR p.linked_user_id IS DISTINCT FROM p_actor_id OR p.estado_vinculacion<>'vinculado' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Only the linked account can request review';END IF;
  INSERT INTO public.torneo_participante_acreditaciones(torneo_id,participante_id,user_id) VALUES(t.id,p.id,p_actor_id)
   ON CONFLICT(participante_id,user_id) DO UPDATE SET estado=CASE WHEN public.torneo_participante_acreditaciones.estado='aprobado' THEN 'aprobado' ELSE 'pendiente' END RETURNING * INTO a;
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','created','solicitud',jsonb_build_object('id',a.id,'participante_id',p.id,'estado',a.estado));
 ELSE
  SELECT * INTO a FROM public.torneo_participante_acreditaciones WHERE id=(p_payload->>'acreditacion_id')::uuid AND torneo_id=t.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Accreditation request missing';END IF;
  IF a.estado<>'pendiente' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Accreditation already resolved';END IF;
  IF p_payload->>'decision' NOT IN('aprobar','rechazar') OR p_payload->>'decision' IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Review decision required';END IF;
  IF p_payload->>'decision'='aprobar' THEN
   SELECT * INTO h FROM public.torneo_homologaciones WHERE torneo_id=t.id;
   IF NOT FOUND OR t.es_prueba IS TRUE OR NOT coalesce((to_jsonb(t)->>'fipa_registration_enabled')::boolean,false) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Official reviewed event required';END IF;
   SELECT * INTO p FROM public.torneo_participantes WHERE id=a.participante_id FOR UPDATE;
   IF p.linked_user_id IS DISTINCT FROM a.user_id OR p.estado_vinculacion<>'vinculado' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Verified linked account required';END IF;
   SELECT * INTO profile FROM public.jugadores_perfil WHERE user_id=a.user_id;
   IF NOT FOUND OR trim(coalesce(profile.nombre,''))='' OR trim(coalesce(profile.apellido,''))='' THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Complete linked profile required';END IF;
   FOR key IN SELECT jsonb_array_elements_text(h.requisitos_snapshot) LOOP
    IF nullif(trim(coalesce(to_jsonb(profile)->>key,'')),'') IS NULL THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Configured FIPA profile requirement missing';END IF;
   END LOOP;
   ref:=trim(coalesce(p_payload->>'referencia_oficial',''));evidence:=trim(coalesce(p_payload->>'evidencia',''));
   IF length(ref) NOT BETWEEN 8 AND 1000 OR length(evidence) NOT BETWEEN 20 AND 4000 OR p_payload->>'confirmar_identidad' IS DISTINCT FROM 'true' OR p_payload->>'confirmar_requisitos' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Verified identity and requirements evidence required';END IF;
   UPDATE public.torneo_participante_acreditaciones SET estado='aprobado',referencia_oficial=ref,evidencia=evidence,resuelto_por=p_actor_id,resolved_at=now() WHERE id=a.id RETURNING * INTO a;
   UPDATE public.torneo_participantes SET ranking_oficial_elegible=true WHERE id=p.id RETURNING * INTO p;
  ELSE
   UPDATE public.torneo_participante_acreditaciones SET estado='rechazado',resuelto_por=p_actor_id,resolved_at=now() WHERE id=a.id RETURNING * INTO a;
  END IF;
  receipt:=jsonb_build_object('ok',true,'torneo_id',t.id,'status','updated','solicitud',jsonb_build_object('id',a.id,'participante_id',a.participante_id,'estado',a.estado),'participante',to_jsonb(p));
 END IF;
 INSERT INTO public.torneo_participante_operaciones(torneo_id,request_id,actor_id,accion,payload,receipt) VALUES(t.id,req,p_actor_id,'acreditacion_'||p_accion,p_payload,receipt);
 RETURN receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.gestionar_acreditacion_participante(bigint,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gestionar_acreditacion_participante(bigint,uuid,text,jsonb) TO service_role;
COMMIT;
