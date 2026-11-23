-- LOCAL candidate only. No changes to the general reservation overlap guard.
CREATE TABLE public.clases_ocurrencias (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 clase_id bigint NOT NULL REFERENCES public.clases(id),
 fecha date NOT NULL, hora_inicio time NOT NULL,
 cancha_id bigint NOT NULL REFERENCES public.canchas(id),
 organizador_id uuid NOT NULL REFERENCES auth.users(id),
 reserva_cancha_id bigint NOT NULL UNIQUE REFERENCES public.reservas(id),
 estado text NOT NULL DEFAULT 'preparada' CHECK(estado IN ('preparada','cancelada')),
 UNIQUE(clase_id,fecha,hora_inicio)
);
ALTER TABLE public.inscripciones_clases ADD COLUMN ocurrencia_id bigint REFERENCES public.clases_ocurrencias(id);
CREATE TABLE public.clases_accesos (
 inscripcion_id bigint PRIMARY KEY REFERENCES public.inscripciones_clases(id),
 token text NOT NULL UNIQUE CHECK(token ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.clases_ocurrencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clases_accesos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clases_ocurrencias,public.clases_accesos FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.clases_ocurrencias,public.clases_accesos TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.clases_ocurrencias_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.clases_ocurrencia_comando(
 p_accion text, p_clase_id bigint, p_user_id uuid,
 p_fecha date DEFAULT NULL, p_hora time DEFAULT NULL,
 p_inscripcion_id bigint DEFAULT NULL, p_ocurrencia_id bigint DEFAULT NULL,
 p_token text DEFAULT NULL, p_super boolean DEFAULT false, p_email text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE c public.clases%ROWTYPE; o public.clases_ocurrencias%ROWTYPE;
 i public.inscripciones_clases%ROWTYPE; p record; s record;
 v_reserva bigint; v_num integer; v_count integer; v_duplicate boolean:=false;
 v_court bigint; v_today date; v_hours integer; v_expected integer; v_written integer;
BEGIN
 IF p_user_id IS NULL THEN RAISE EXCEPTION 'CLASE_NO_AUTORIZADO'; END IF;
 -- All commands acquire class first, then occurrence/enrollment: consistent lock order.
 SELECT * INTO c FROM public.clases WHERE id=p_clase_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_NO_ENCONTRADA'; END IF;
 SELECT * INTO s FROM public.sedes WHERE id=c.sede_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_SEDE_NO_ENCONTRADA'; END IF;
 IF s.timezone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=s.timezone) THEN RAISE EXCEPTION 'CLASE_TIMEZONE_REVISAR'; END IF;
 IF p_accion IN ('preparar','inscribir') THEN
  IF c.activo IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.profesores WHERE id=c.profesor_id AND aprobado AND activo) THEN RAISE EXCEPTION 'CLASE_INACTIVA'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.clases_horarios WHERE clase_id=c.id AND dia_semana=extract(dow FROM p_fecha) AND hora_inicio=p_hora) THEN RAISE EXCEPTION 'CLASE_HORARIO_INVALIDO'; END IF;
  SELECT * INTO o FROM public.clases_ocurrencias WHERE clase_id=c.id AND fecha=p_fecha AND hora_inicio=p_hora AND estado='preparada' FOR UPDATE;
  IF FOUND AND (o.estado<>'preparada' OR o.cancha_id IS DISTINCT FROM c.cancha_id) THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_DISPONIBLE'; END IF;
 END IF;
 IF p_accion='preparar' THEN
  IF o.id IS NOT NULL THEN
   IF o.organizador_id<>p_user_id AND NOT p_super THEN RAISE EXCEPTION 'CLASE_OTRO_ORGANIZADOR'; END IF;
   RETURN jsonb_build_object('ocurrencia_id',o.id,'clase_id',c.id,'fecha',o.fecha,'hora_inicio',to_char(o.hora_inicio,'HH24:MI'),'estado',o.estado,'reutilizada',true);
  END IF;
  IF coalesce(s.tipo_sede,'')='torneo' THEN RAISE EXCEPTION 'CLASE_SEDE_NO_RESERVABLE'; END IF;
  -- Source is the authenticated organizer's persisted real profile, never request contacts.
  IF (SELECT count(*) FROM public.jugadores_perfil WHERE user_id=p_user_id AND lower(trim(email))=lower(trim(p_email)))<>1 THEN RAISE EXCEPTION 'CLASE_ORGANIZADOR_CONTACTO_REQUERIDO'; END IF;
  SELECT trim(j.nombre) nombre,trim(j.apellido) apellido,lower(trim(j.email)) email,trim(j.whatsapp) whatsapp
   INTO p FROM public.jugadores_perfil j WHERE j.user_id=p_user_id AND lower(trim(j.email))=lower(trim(p_email));
  IF NOT FOUND OR coalesce(p.nombre,'')='' OR coalesce(p.email,'') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    OR coalesce(p.whatsapp,'') !~ '^\+?[0-9 ()-]{7,25}$' OR length(regexp_replace(coalesce(p.whatsapp,''),'[^0-9]','','g')) NOT BETWEEN 7 AND 15 THEN RAISE EXCEPTION 'CLASE_ORGANIZADOR_CONTACTO_REQUERIDO'; END IF;
  SELECT CASE WHEN orden>0 THEN orden ELSE numero END INTO v_num FROM (
   SELECT id,orden,row_number() OVER(ORDER BY id)::int numero FROM public.canchas WHERE sede_id=c.sede_id
  ) courts WHERE id=c.cancha_id;
  IF v_num IS NULL THEN RAISE EXCEPTION 'CLASE_CANCHA_INVALIDA'; END IF;
  IF c.duracion_minutos IS NULL OR c.duracion_minutos<15 THEN RAISE EXCEPTION 'CLASE_DURACION_INVALIDA'; END IF;
  IF c.precio<>trunc(c.precio) OR c.precio<0 THEN RAISE EXCEPTION 'CLASE_PRECIO_REVISAR'; END IF;
  INSERT INTO public.reservas(sede,sede_id,fecha,hora,hora_inicio,cancha,cancha_id,nombre,email,telefono,whatsapp,nivel,precio,moneda,estado,duracion_minutos,user_id,tipo)
   VALUES(s.nombre,s.id,p_fecha::text,to_char(p_hora,'HH24:MI'),to_char(p_hora,'HH24:MI'),v_num,c.cancha_id,concat_ws(' ',p.nombre,nullif(p.apellido,'')),p.email,p.whatsapp,p.whatsapp,'Clase',c.precio,coalesce(s.moneda,'ARS'),'confirmada',c.duracion_minutos,p_user_id,'clase') RETURNING id INTO v_reserva;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  INSERT INTO public.clases_ocurrencias(clase_id,fecha,hora_inicio,cancha_id,organizador_id,reserva_cancha_id)
   VALUES(c.id,p_fecha,p_hora,c.cancha_id,p_user_id,v_reserva) RETURNING * INTO o;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  RETURN jsonb_build_object('ocurrencia_id',o.id,'clase_id',c.id,'fecha',o.fecha,'hora_inicio',to_char(o.hora_inicio,'HH24:MI'),'estado',o.estado,'reutilizada',false);
 ELSIF p_accion='inscribir' THEN
  IF o.id IS NULL THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_PREPARADA'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.reservas WHERE id=o.reserva_cancha_id AND estado='confirmada') THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_DISPONIBLE'; END IF;
  SELECT * INTO i FROM public.inscripciones_clases WHERE clase_id=c.id AND user_id=p_user_id AND fecha=p_fecha AND hora_inicio=p_hora FOR UPDATE;
  IF FOUND AND coalesce(i.estado,'')<>'cancelada' THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_DUPLICADA'; END IF;
  SELECT count(*) INTO v_count FROM public.inscripciones_clases WHERE clase_id=c.id AND fecha=p_fecha AND hora_inicio=p_hora AND estado IN('pendiente','confirmada');
  IF v_count>=coalesce(c.cupo_maximo,4) THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_COMPLETA'; END IF;
  IF i.id IS NULL THEN
   INSERT INTO public.inscripciones_clases(clase_id,user_id,fecha,hora_inicio,estado,reserva_cancha_id,ocurrencia_id)
    VALUES(c.id,p_user_id,p_fecha,p_hora,'pendiente',o.reserva_cancha_id,o.id) RETURNING * INTO i;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  ELSE
   UPDATE public.inscripciones_clases SET estado='pendiente',reserva_cancha_id=o.reserva_cancha_id,ocurrencia_id=o.id,asistio=false,asistencia_marcada_at=NULL,asistencia_marcada_por=NULL WHERE id=i.id RETURNING * INTO i;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  END IF;
 ELSIF p_accion IN ('retirar','acceso','checkin') THEN
  SELECT * INTO i FROM public.inscripciones_clases WHERE id=p_inscripcion_id AND clase_id=c.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_NO_ENCONTRADA'; END IF;
  IF p_accion<>'checkin' AND i.user_id IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_AJENA'; END IF;
  IF p_accion='retirar' THEN
   IF i.estado='cancelada' THEN RETURN jsonb_build_object('ok',true,'ya_cancelada',true); END IF;
   v_hours:=greatest(coalesce(c.horas_cancelacion,24),0);
   IF (i.fecha+i.hora_inicio) AT TIME ZONE s.timezone < now()+make_interval(hours=>v_hours) THEN RAISE EXCEPTION 'CLASE_CANCELACION_FUERA_PLAZO'; END IF;
   UPDATE public.inscripciones_clases SET estado='cancelada' WHERE id=i.id;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
   DELETE FROM public.clases_accesos WHERE inscripcion_id=i.id;
   RETURN jsonb_build_object('ok',true);
  END IF;
  SELECT * INTO o FROM public.clases_ocurrencias WHERE id=i.ocurrencia_id FOR UPDATE;
  IF NOT FOUND OR o.estado<>'preparada' OR coalesce(i.estado,'') NOT IN('pendiente','confirmada') THEN RAISE EXCEPTION 'CLASE_INSCRIPCION_NO_ACTIVA'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.reservas WHERE id=o.reserva_cancha_id AND estado='confirmada') THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_DISPONIBLE'; END IF;
  IF p_accion='acceso' THEN
   IF p_token !~ '^[0-9a-f]{64}$' OR p_token IS NULL THEN RAISE EXCEPTION 'CLASE_TOKEN_INVALIDO'; END IF;
   INSERT INTO public.clases_accesos(inscripcion_id,token) VALUES(i.id,p_token) ON CONFLICT(inscripcion_id) DO NOTHING;
   RETURN (SELECT jsonb_build_object('inscripcion_id',i.id,'clase_id',i.clase_id,'qr_code',token,'tipo','clase') FROM public.clases_accesos WHERE inscripcion_id=i.id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.clases_accesos WHERE inscripcion_id=i.id AND token=p_token) THEN RAISE EXCEPTION 'CLASE_TOKEN_INVALIDO'; END IF;
  IF nullif(s.timezone,'') IS NULL THEN RAISE EXCEPTION 'CLASE_TIMEZONE_REVISAR'; END IF;
  v_today:=(now() AT TIME ZONE s.timezone)::date;
  IF i.fecha<>v_today THEN RAISE EXCEPTION 'CLASE_CHECKIN_FECHA_INVALIDA'; END IF;
  IF i.asistio IS TRUE THEN RAISE EXCEPTION 'CLASE_CHECKIN_YA_REALIZADO'; END IF;
  UPDATE public.inscripciones_clases SET asistio=true,asistencia_marcada_at=now(),asistencia_marcada_por=p_user_id::text WHERE id=i.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  RETURN jsonb_build_object('ok',true,'inscripcion_id',i.id,'asistio',true);
 ELSIF p_accion='cancelar_ocurrencia' THEN
  SELECT * INTO o FROM public.clases_ocurrencias WHERE id=p_ocurrencia_id AND clase_id=c.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_NO_ENCONTRADA'; END IF;
  IF o.organizador_id<>p_user_id AND NOT p_super THEN RAISE EXCEPTION 'CLASE_OTRO_ORGANIZADOR'; END IF;
  IF o.estado='cancelada' THEN RETURN jsonb_build_object('ok',true,'ya_cancelada',true); END IF;
  SELECT count(*) INTO v_expected FROM public.inscripciones_clases WHERE ocurrencia_id=o.id;
  UPDATE public.inscripciones_clases SET estado='cancelada' WHERE ocurrencia_id=o.id;
  GET DIAGNOSTICS v_written=ROW_COUNT;
  IF v_written<>v_expected THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  DELETE FROM public.clases_accesos WHERE inscripcion_id IN(SELECT id FROM public.inscripciones_clases WHERE ocurrencia_id=o.id);
  UPDATE public.clases_ocurrencias SET estado='cancelada' WHERE id=o.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_ESCRITURA_INCOMPLETA'; END IF;
  UPDATE public.reservas SET estado='cancelada' WHERE id=o.reserva_cancha_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLASE_RESERVA_NO_ENCONTRADA'; END IF;
  RETURN jsonb_build_object('ok',true);
 ELSE RAISE EXCEPTION 'CLASE_COMANDO_INVALIDO'; END IF;
 -- Student DTO deliberately excludes shared booking ownership/token.
 RETURN jsonb_build_object('id',i.id,'clase_id',i.clase_id,'fecha',i.fecha,'hora_inicio',to_char(i.hora_inicio,'HH24:MI'),'estado',i.estado,'ocurrencia_id',i.ocurrencia_id,'asistio',coalesce(i.asistio,false));
END $$;
REVOKE ALL ON FUNCTION public.clases_ocurrencia_comando(text,bigint,uuid,date,time,bigint,bigint,text,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clases_ocurrencia_comando(text,bigint,uuid,date,time,bigint,bigint,text,boolean,text) TO service_role;
