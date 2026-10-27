BEGIN;
-- Rechazar nuevas inscripciones después del último día del evento, usando
-- la zona del plan o la sede. No modifica estados ni registros existentes.
CREATE OR REPLACE FUNCTION public.torneo_inscripcion_fecha_vigente(p_fin date, p_sede_id bigint, p_plan jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE zone_name text;
BEGIN
 IF p_fin IS NULL THEN RETURN true; END IF;
 SELECT coalesce(nullif(p_plan#>>'{config,timezone}',''),nullif(s.timezone,''),'America/Argentina/Buenos_Aires')
 INTO zone_name FROM (SELECT 1) x LEFT JOIN public.sedes s ON s.id=p_sede_id;
 RETURN (now() AT TIME ZONE zone_name)::date <= p_fin;
EXCEPTION WHEN invalid_parameter_value THEN RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.torneo_inscripcion_fecha_vigente(date,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.torneo_inscripcion_fecha_vigente(date,bigint,jsonb) TO service_role;

-- Modificar exactamente las versiones conocidas; abortar sin cambios si la
-- versión instalada difiere, para no sobrescribir mejoras concurrentes.
DO $patch$
DECLARE def text; old text; new text; signature regprocedure;
BEGIN
 signature := to_regprocedure('public.gestionar_participantes_torneo(bigint,uuid,text,jsonb)');
 IF signature IS NULL THEN RAISE EXCEPTION 'No existe RPC de participantes'; END IF;
 SELECT pg_get_functiondef(signature) INTO def;
 old := $$open_registration:=coalesce(t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion'),false)
  AND NOT EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id);$$;
 new := $$open_registration:=coalesce(t.estado IN('abierto','inscripcion','inscripcion_abierta','proximo','planificacion'),false)
  AND public.torneo_inscripcion_fecha_vigente(t.fecha_fin,t.sede_id,t.plan_nations)
  AND NOT EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=t.id);$$;
 IF position(old IN def)=0 OR position(new IN def)>0 THEN RAISE EXCEPTION 'Versión inesperada de RPC de participantes'; END IF;
 EXECUTE replace(def,old,new);

 signature := to_regprocedure('public.guardar_plantel_seleccion(bigint,bigint,uuid,boolean,text,text,integer,boolean,uuid[],bigint)');
 IF signature IS NULL THEN RAISE EXCEPTION 'No existe RPC de selecciones'; END IF;
 SELECT pg_get_functiondef(signature) INTO def;
 old := $$ IF p_accion='crear' THEN
  IF p_cupo$$;
 new := $$ IF p_accion='crear' THEN
  IF NOT public.torneo_inscripcion_fecha_vigente(t.fecha_fin,t.sede_id,t.plan_nations) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Registration closed'; END IF;
  IF p_cupo$$;
 IF position(old IN def)=0 OR position(new IN def)>0 THEN RAISE EXCEPTION 'Versión inesperada de creación de selección'; END IF;
 def:=replace(def,old,new);
 old := $$   IF e.inscripcion_estado='confirmado' THEN result_status:='idempotent'; ELSE UPDATE public.equipos$$;
 new := $$   IF e.inscripcion_estado='confirmado' THEN result_status:='idempotent'; ELSE
    IF NOT public.torneo_inscripcion_fecha_vigente(t.fecha_fin,t.sede_id,t.plan_nations) THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Registration closed'; END IF;
    UPDATE public.equipos$$;
 IF position(old IN def)=0 OR position(new IN def)>0 THEN RAISE EXCEPTION 'Versión inesperada de confirmación de selección'; END IF;
 EXECUTE replace(def,old,new);
END $patch$;
COMMIT;
