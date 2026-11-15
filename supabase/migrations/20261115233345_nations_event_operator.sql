-- A single event-scoped operator; no changes to public.user_roles or Auth accounts.
CREATE SCHEMA IF NOT EXISTS nations_operator;
REVOKE ALL ON SCHEMA nations_operator FROM PUBLIC,anon,authenticated;
CREATE TABLE IF NOT EXISTS nations_operator.grants(
 id uuid PRIMARY KEY,user_id uuid NOT NULL,torneo_id bigint NOT NULL CHECK(torneo_id=57),
 granted_by uuid NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,torneo_id));
CREATE TABLE IF NOT EXISTS nations_operator.audit(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id uuid NOT NULL,torneo_id bigint NOT NULL CHECK(torneo_id=57),
 action text NOT NULL CHECK(action IN('grant','revoke')),grant_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE nations_operator.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE nations_operator.audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nations_operator FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA nations_operator FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION nations_operator.has_grant(p_user uuid,p_event bigint,p_action text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE permitted boolean;
BEGIN
 IF p_event IS DISTINCT FROM 57 OR p_action IS NULL OR p_action NOT IN('schedule','lineup','scoreboard','control','read') THEN RETURN false; END IF;
 SELECT true INTO permitted FROM nations_operator.grants g JOIN auth.users u ON u.id=g.user_id
 WHERE g.user_id=p_user AND g.torneo_id=p_event AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
 AND u.email_confirmed_at IS NOT NULL AND to_jsonb(u)->>'deleted_at' IS NULL
 AND NOT coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz>clock_timestamp(),false)
 FOR SHARE OF g,u;
 RETURN coalesce(permitted,false);
END $fn$;
REVOKE ALL ON FUNCTION nations_operator.has_grant(uuid,bigint,text) FROM PUBLIC,anon,authenticated;
-- Preserve the live canonical sporting/occupancy code. Only replace exact known
-- authorization predicates, aborting on drift instead of overwriting a function.
DO $migration$
DECLARE definition text; old_guard text; new_guard text; signature text;
BEGIN
 signature:='public.guardar_plan_nations_before_occupancy_candidate(bigint,uuid,text,bigint,uuid,text,jsonb)';
 definition:=pg_get_functiondef(signature::regprocedure);
 old_guard:=$old$IF NOT EXISTS(SELECT 1 FROM public.user_roles u WHERE u.user_id=p_actor_id AND (u.role='super_admin' OR u.role='admin_club' AND u.sede_id=t.sede_id)) THEN$old$;
 new_guard:=$new$IF NOT (EXISTS(SELECT 1 FROM public.user_roles u WHERE u.user_id=p_actor_id AND (u.role='super_admin' OR u.role='admin_club' AND u.sede_id=t.sede_id)) OR (p_action='programacion' AND nations_operator.has_grant(p_actor_id,t.id,'schedule'))) THEN$new$;
 IF position(old_guard IN definition)=0 OR length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) THEN RAISE EXCEPTION 'Operator migration guard drift: %',signature; END IF;
 EXECUTE replace(definition,old_guard,new_guard);
 signature:='public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)';
 definition:=pg_get_functiondef(signature::regprocedure);
 old_guard:=$old$(r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true$old$;
 new_guard:=$new$(r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id OR nations_operator.has_grant(p_actor_id,t.id,'scoreboard')) IS DISTINCT FROM true$new$;
 IF position(old_guard IN definition)=0 OR length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) THEN RAISE EXCEPTION 'Operator migration guard drift: %',signature; END IF;
 EXECUTE replace(definition,old_guard,new_guard);
 signature:='public.guardar_alineacion_participantes(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint)';
 definition:=pg_get_functiondef(signature::regprocedure);
 old_guard:=$old$(e.creador_id=p_actor_id OR r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id) IS DISTINCT FROM true$old$;
 new_guard:=$new$(e.creador_id=p_actor_id OR r.role='super_admin' OR r.role='admin_club' AND r.sede_id=t.sede_id OR nations_operator.has_grant(p_actor_id,t.id,'lineup')) IS DISTINCT FROM true$new$;
 IF position(old_guard IN definition)=0 OR length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) THEN RAISE EXCEPTION 'Operator migration guard drift: %',signature; END IF;
 EXECUTE replace(definition,old_guard,new_guard);
END $migration$;
