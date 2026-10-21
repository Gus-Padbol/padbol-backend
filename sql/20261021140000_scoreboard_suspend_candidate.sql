-- Experimental candidate: no production deployment until reactivation and court occupancy are integrated and tested.
CREATE OR REPLACE FUNCTION public.proteger_cancha_marcador_activo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.canchas;m public.partidos;
BEGIN
 IF NEW.sede_id IS NULL OR NEW.cancha IS NULL OR lower(coalesce(NEW.estado,'')) IN('terminado','finalizado','cancelado','suspendido') THEN RETURN NEW;END IF;
 -- Preserve historical active controls: only a new claim, reassignment or reactivation acquires a screen.
 IF TG_OP='UPDATE' AND NEW.sede_id IS NOT DISTINCT FROM OLD.sede_id AND NEW.cancha IS NOT DISTINCT FROM OLD.cancha AND lower(coalesce(OLD.estado,'')) NOT IN('terminado','finalizado','cancelado','suspendido') THEN RETURN NEW;END IF;
 SELECT * INTO c FROM canchas x WHERE x.sede_id=NEW.sede_id AND coalesce(x.orden,(SELECT count(*)::int FROM canchas y WHERE y.sede_id=x.sede_id AND y.id<=x.id))::text=NEW.cancha ORDER BY id LIMIT 1 FOR UPDATE;
 IF c.id IS NULL THEN
  -- Manual/legacy markers accept free-text court labels; this migration does not redefine them.
  IF NEW.partido_torneo_id IS NOT NULL AND EXISTS(SELECT 1 FROM partidos WHERE id=NEW.partido_torneo_id AND cancha_id IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Valid court required';END IF;
  RETURN NEW;
 END IF;
 IF lower(coalesce(c.estado,'')) IN('inactiva','inactivo','cerrada','mantenimiento') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Court not eligible';END IF;
 IF NEW.partido_torneo_id IS NOT NULL THEN
  SELECT * INTO m FROM partidos WHERE id=NEW.partido_torneo_id;
  IF EXISTS(SELECT 1 FROM torneos WHERE id=m.torneo_id AND coalesce(deporte,'padbol')<>coalesce(c.deporte,'padbol')) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Court sport mismatch';END IF;
  PERFORM id FROM equipos WHERE id IN(m.equipo_a_id,m.equipo_b_id) ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM scoreboard_partidos s JOIN partidos p ON p.id=s.partido_torneo_id WHERE s.id IS DISTINCT FROM NEW.id AND p.id<>m.id AND (m.equipo_a_id IN(p.equipo_a_id,p.equipo_b_id) OR m.equipo_b_id IN(p.equipo_a_id,p.equipo_b_id)) AND lower(coalesce(s.estado,'')) NOT IN('terminado','finalizado','cancelado')) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Team already using a scoreboard';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM scoreboard_partidos s WHERE s.sede_id=NEW.sede_id AND s.cancha=NEW.cancha AND s.id IS DISTINCT FROM NEW.id AND lower(coalesce(s.estado,'')) NOT IN('terminado','finalizado','cancelado','suspendido')) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court screen occupied';END IF;
 RETURN NEW;
END $$;

-- Lock tournament and match first, consistent with their integrity triggers;
-- CAS checks the marker again after acquiring those locks. Scoring/history are untouched.
CREATE OR REPLACE FUNCTION public.scoreboard_suspend_candidate(
 p_id uuid, p_expected timestamptz, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE initial public.scoreboard_partidos; current_row public.scoreboard_partidos;
        m public.partidos; r public.user_roles; elapsed integer := 0;
BEGIN
 SELECT * INTO initial FROM public.scoreboard_partidos WHERE id=p_id;
 IF initial.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor;
 IF NOT (r.role='super_admin' OR r.role IN('admin_club','admin_sede') AND r.sede_id=initial.sede_id) IS TRUE THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scoreboard control scope denied';
 END IF;
 -- Other linked entities require their own atomic handling; fail closed.
 IF initial.partido_abierto_id IS NOT NULL OR initial.reserva_id IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Linked open matches or reservations require supported suspension';
 END IF;
 IF initial.torneo_id IS NOT NULL THEN
  PERFORM id FROM public.torneos WHERE id=initial.torneo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Tournament missing'; END IF;
 END IF;
 IF initial.partido_torneo_id IS NOT NULL THEN
  SELECT * INTO m FROM public.partidos WHERE id=initial.partido_torneo_id FOR UPDATE;
  IF m.id IS NULL OR m.torneo_id IS DISTINCT FROM initial.torneo_id OR m.sede_id IS DISTINCT FROM initial.sede_id
     OR lower(coalesce(m.estado,'')) IN('finalizado','terminado','cancelado','suspendido') THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Linked match cannot be suspended';
  END IF;
 END IF;
 SELECT * INTO current_row FROM public.scoreboard_partidos WHERE id=p_id FOR UPDATE;
 IF current_row.updated_at IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
 IF current_row.torneo_id IS DISTINCT FROM initial.torneo_id OR current_row.partido_torneo_id IS DISTINCT FROM initial.partido_torneo_id
    OR current_row.sede_id IS DISTINCT FROM initial.sede_id OR current_row.partido_abierto_id IS NOT NULL OR current_row.reserva_id IS NOT NULL THEN RETURN NULL; END IF;
 IF current_row.estado IS DISTINCT FROM 'en_curso' THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Only ongoing matches can be suspended';
 END IF;
 IF current_row.cronometro_inicio IS NOT NULL AND NOT coalesce(current_row.cronometro_pausado,false) THEN
  elapsed := greatest(0,floor(extract(epoch FROM (clock_timestamp()-current_row.cronometro_inicio)))::integer);
 END IF;
 IF current_row.partido_torneo_id IS NOT NULL THEN
  UPDATE public.partidos SET estado='suspendido' WHERE id=current_row.partido_torneo_id;
 END IF;
 UPDATE public.scoreboard_partidos SET estado='suspendido',cronometro_inicio=NULL,
  cronometro_pausado=true,cronometro_segundos=greatest(0,coalesce(cronometro_segundos,0))+elapsed
 WHERE id=p_id RETURNING * INTO current_row;
 RETURN to_jsonb(current_row)-'control_token_hash'-'control_token_created_at'-'control_token_revoked_at';
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_suspend_candidate(uuid,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_suspend_candidate(uuid,timestamptz,uuid) TO service_role;
