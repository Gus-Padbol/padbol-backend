-- EXPERIMENTAL ONLY: review production privileges, locks and triggers before use.
-- Fixed-duration tariffs only; dynamic pricing and active time bands fail closed.
-- Preserve the deployed overlap guard while covering the existing in-person payment states.
CREATE OR REPLACE FUNCTION public.reservas_guardar_sin_solape()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE nombre_sede text; slot tsrange; court text; venue_id bigint; venue_count integer;
BEGIN
  IF lower(coalesce(NEW.estado,'')) NOT IN('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND lower(coalesce(OLD.estado,'')) IN('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva')
     AND ROW(NEW.sede_id,NEW.sede,NEW.fecha,NEW.cancha,NEW.hora,NEW.hora_inicio,NEW.duracion_minutos)
         IS NOT DISTINCT FROM ROW(OLD.sede_id,OLD.sede,OLD.fecha,OLD.cancha,OLD.hora,OLD.hora_inicio,OLD.duracion_minutos) THEN RETURN NEW; END IF;
  venue_id:=NEW.sede_id;
  IF venue_id IS NULL THEN
    SELECT count(*),min(s.id) INTO venue_count,venue_id FROM public.sedes s WHERE lower(trim(s.nombre))=lower(trim(NEW.sede));
    IF venue_count<>1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation venue is missing or ambiguous'; END IF;
  END IF;
  SELECT lower(trim(s.nombre)) INTO nombre_sede FROM public.sedes s WHERE s.id=venue_id;
  court:=trim(NEW.cancha::text);
  IF court ~ '^[0-9]+$' THEN court:=(court::bigint)::text; END IF;
  slot:=public.reserva_intervalo_guard(NEW.fecha::text,NEW.hora::text,NEW.hora_inicio::text,NEW.duracion_minutos);
  IF nombre_sede IS NULL OR court IS NULL OR court='' OR slot IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid reservation slot';
  END IF;
  -- Court-wide lock also covers midnight overlap and reservations with legacy venue names.
  PERFORM pg_advisory_xact_lock(hashtextextended('reservas-slot:'||nombre_sede||':'||court,0));
  IF EXISTS(SELECT 1 FROM public.reservas r
    WHERE r.id IS DISTINCT FROM NEW.id AND (lower(coalesce(r.estado,'')) IN('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva') OR (lower(coalesce(r.estado,''))='suspendida' AND NOT EXISTS (SELECT 1 FROM public.scoreboard_linked_suspend_candidate ss JOIN public.scoreboard_partidos sx ON sx.id=ss.scoreboard_id WHERE ss.booking_id=r.id AND sx.estado='suspendido' AND (sx.reserva_id=r.id OR EXISTS (SELECT 1 FROM public.partidos_abiertos ax WHERE ax.id=sx.partido_abierto_id AND ax.id=ss.open_id AND ax.reserva_id=r.id)))))
      AND (r.sede_id=venue_id OR r.sede_id IS NULL AND lower(trim(coalesce(r.sede,'')))=nombre_sede)
      AND CASE WHEN trim(r.cancha::text) ~ '^[0-9]+$' THEN (trim(r.cancha::text)::bigint)::text ELSE trim(r.cancha::text) END=court
      AND public.reserva_intervalo_guard(r.fecha::text,r.hora::text,r.hora_inicio::text,r.duracion_minutos) && slot)
  THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Reservation slot overlaps an active booking'; END IF;
  RETURN NEW;
END $$;

CREATE TABLE manual_player_booking_receipts (
 reference uuid PRIMARY KEY, actor_id uuid NOT NULL, payload jsonb NOT NULL,
 reserva_id bigint NOT NULL REFERENCES reservas(id)
);
ALTER TABLE manual_player_booking_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON manual_player_booking_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION manual_player_booking_candidate(
 p_reference uuid,p_actor uuid,p_player uuid,p_sede integer,p_court bigint,
 p_date text,p_time text,p_duration integer,p_expected_price integer,p_guest_name text DEFAULT NULL,p_guest_telefono text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_role user_roles%ROWTYPE; v_profile jugadores_perfil%ROWTYPE; v_court canchas%ROWTYPE;
 v_sede sedes%ROWTYPE; v_payload jsonb; v_receipt manual_player_booking_receipts%ROWTYPE;
 v_count integer; v_price numeric; v_reserva bigint; v_display text; v_range tsrange;
 v_open integer; v_close integer; v_start integer; v_receipt_estado text; v_receipt_pago text; v_email text; v_telefono text; v_whatsapp text; v_nivel text;
BEGIN
 IF p_reference IS NULL OR p_actor IS NULL OR p_sede IS NULL OR p_court IS NULL
 OR (p_player IS NULL AND (nullif(trim(p_guest_name),'') IS NULL OR length(p_guest_name)>120 OR length(coalesce(p_guest_telefono,''))>40)) OR p_duration IS NULL OR p_expected_price IS NULL OR p_expected_price<0 OR p_date IS NULL OR p_time IS NULL
 OR p_duration NOT IN (60,90,120) OR p_date !~ '^\d{4}-\d{2}-\d{2}$' OR p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
 THEN RAISE EXCEPTION 'invalid_booking' USING ERRCODE='22023'; END IF;
 v_range:=reserva_intervalo_guard(p_date,p_time,p_time,p_duration);
 IF v_range IS NULL THEN RAISE EXCEPTION 'invalid_slot' USING ERRCODE='22023'; END IF;
 -- All role writers must be serialized, including inserts. This is a
 -- deliberately conservative global lock; review impact and lock ordering.
 LOCK TABLE user_roles IN SHARE MODE;
 PERFORM 1 FROM user_roles WHERE user_id=p_actor FOR SHARE;
 SELECT count(*) INTO v_count FROM user_roles WHERE user_id=p_actor;
 IF v_count<>1 THEN RAISE EXCEPTION 'booking_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_role FROM user_roles WHERE user_id=p_actor;
 IF (lower(v_role.role)='super_admin' OR lower(v_role.role)='admin_club' AND v_role.sede_id=p_sede) IS NOT TRUE THEN
  RAISE EXCEPTION 'booking_forbidden' USING ERRCODE='42501'; END IF;
 v_payload:=jsonb_build_object('actor',p_actor,'player',p_player,'sede',p_sede,'court',p_court,'date',p_date,'time',p_time,'duration',p_duration,'expected_price',p_expected_price,'guest_name',CASE WHEN p_player IS NULL THEN trim(p_guest_name) ELSE NULL END,'guest_telefono',CASE WHEN p_player IS NULL THEN trim(coalesce(p_guest_telefono,'')) ELSE NULL END);
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking:'||p_reference::text,0));
 SELECT * INTO v_receipt FROM manual_player_booking_receipts WHERE reference=p_reference;
 IF FOUND THEN
  IF v_receipt.actor_id<>p_actor OR v_receipt.payload<>v_payload THEN RAISE EXCEPTION 'reference_conflict' USING ERRCODE='23505'; END IF;
  SELECT estado,pago_estado INTO v_receipt_estado,v_receipt_pago FROM reservas WHERE id=v_receipt.reserva_id FOR SHARE;
  IF NOT FOUND OR nullif(trim(v_receipt_estado),'') IS NULL THEN RAISE EXCEPTION 'receipt_unavailable' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('id',v_receipt.reserva_id::text,'status',v_receipt_estado,'pago_estado',v_receipt_pago,'recuperada',true);
 END IF;
 SELECT * INTO v_sede FROM sedes WHERE id=p_sede FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'venue_missing' USING ERRCODE='22023'; END IF;
 IF coalesce(v_sede.surge_activo,false) THEN RAISE EXCEPTION 'pricing_requires_review' USING ERRCODE='55000'; END IF;
 -- Match the existing slot policy: a booking cannot span midnight, even for
 -- venues whose operating window continues into the next calendar day.
 IF coalesce(v_sede.horario_apertura,'10:00') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
 OR coalesce(v_sede.horario_cierre,'23:00') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
  RAISE EXCEPTION 'venue_hours_invalid' USING ERRCODE='55000'; END IF;
 v_open:=split_part(coalesce(v_sede.horario_apertura,'10:00'),':',1)::integer*60+split_part(coalesce(v_sede.horario_apertura,'10:00'),':',2)::integer;
 v_close:=split_part(coalesce(v_sede.horario_cierre,'23:00'),':',1)::integer*60+split_part(coalesce(v_sede.horario_cierre,'23:00'),':',2)::integer;
 v_start:=split_part(p_time,':',1)::integer*60+split_part(p_time,':',2)::integer;
 IF NOT (CASE WHEN v_close>v_open THEN v_start>=v_open AND v_start+p_duration<=v_close
 ELSE (v_start>=v_open AND v_start+p_duration<=1440) OR (v_start<v_close AND v_start+p_duration<=v_close) END)
 THEN RAISE EXCEPTION 'outside_venue_hours' USING ERRCODE='22023'; END IF;

 IF ((p_date || ' ' || p_time)::timestamp AT TIME ZONE coalesce(nullif(trim(v_sede.timezone),''),'America/Argentina/Buenos_Aires')) <= clock_timestamp() THEN
  RAISE EXCEPTION 'slot_in_past' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 SELECT * INTO v_court FROM canchas WHERE id=p_court AND sede_id=p_sede FOR SHARE;
 IF NOT FOUND OR v_court.orden IS NULL OR v_court.orden<1 OR p_court>2147483647 OR lower(trim(coalesce(v_court.estado,''))) NOT IN ('activa','activo') THEN
  RAISE EXCEPTION 'court_unavailable' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM canchas WHERE sede_id=p_sede AND orden=v_court.orden;
 IF v_count<>1 THEN RAISE EXCEPTION 'court_ambiguous' USING ERRCODE='22023'; END IF;
 -- Experimental common lock also acquired by the guards below.

 IF EXISTS(SELECT 1 FROM partidos_abiertos p WHERE p.sede_id=p_sede
   AND lower(coalesce(p.estado,'')) IN ('abierto','completo')
   AND (p.cancha_id=p_court OR trim(p.cancha)=v_court.orden::text OR (p.cancha_id IS NULL AND coalesce(trim(p.cancha),'') !~ '^[0-9]+$'))
   AND (p.fecha IS NULL OR (public.reserva_intervalo_guard(p.fecha::text,p.hora::text,NULL,p.duracion_minutos) IS NULL AND p.fecha BETWEEN p_date::date-1 AND p_date::date) OR public.reserva_intervalo_guard(p.fecha::text,p.hora::text,NULL,p.duracion_minutos) && v_range))
 THEN RAISE EXCEPTION 'court_occupied_by_match' USING ERRCODE='23P01'; END IF;
 IF EXISTS(SELECT 1 FROM clases c JOIN clases_horarios h ON h.clase_id=c.id
   WHERE c.sede_id=p_sede AND c.activo=true AND (c.cancha_id=p_court OR c.cancha_id IS NULL)
   AND (h.dia_semana=extract(dow FROM p_date::date)::int OR ((h.hora_fin IS NULL OR h.hora_inicio IS NULL OR h.hora_fin<=h.hora_inicio) AND h.dia_semana=extract(dow FROM p_date::date-1)::int))
   AND (h.hora_inicio IS NULL OR h.hora_fin IS NULL OR h.hora_fin<=h.hora_inicio OR tsrange(p_date::date+h.hora_inicio,p_date::date+h.hora_fin,'[)') && v_range))
 THEN RAISE EXCEPTION 'court_occupied_by_class' USING ERRCODE='23P01'; END IF;
 IF p_player IS NULL THEN
  v_display:=trim(p_guest_name); v_email:=''; v_telefono:=trim(coalesce(p_guest_telefono,''));
  v_whatsapp:=''; v_nivel:='';
 ELSE
  SELECT * INTO v_profile FROM jugadores_perfil WHERE user_id=p_player FOR SHARE;
  IF NOT FOUND OR nullif(trim(v_profile.email),'') IS NULL OR (v_profile.suspendido_hasta IS NOT NULL AND v_profile.suspendido_hasta>now()) THEN
   RAISE EXCEPTION 'player_unavailable' USING ERRCODE='22023'; END IF;
  v_display:=coalesce(nullif(trim(concat_ws(' ',v_profile.nombre,v_profile.apellido)),''),nullif(trim(v_profile.alias),''));
  IF v_display IS NULL THEN RAISE EXCEPTION 'player_name_required' USING ERRCODE='22023'; END IF;
  v_email:=lower(trim(v_profile.email)); v_telefono:=coalesce(v_profile.telefono,'');
  v_whatsapp:=coalesce(v_profile.whatsapp,''); v_nivel:=coalesce(v_profile.nivel,'');
 END IF;
 -- Conservative table locks prevent changes to pricing while this transaction calculates/inserts.
 LOCK TABLE sedes_duraciones, franjas_precio, surge_config IN SHARE MODE;
 IF EXISTS(SELECT 1 FROM surge_config WHERE sede_id=p_sede AND deporte=coalesce(nullif(lower(trim(v_court.deporte)),''),'padbol') AND activo)
 OR EXISTS(SELECT 1 FROM franjas_precio WHERE sede_id=p_sede AND deporte=coalesce(nullif(lower(trim(v_court.deporte)),''),'padbol') AND activo)
 THEN RAISE EXCEPTION 'pricing_requires_review' USING ERRCODE='55000'; END IF;
 SELECT count(*), min(precio) INTO v_count,v_price FROM sedes_duraciones
 WHERE sede_id=p_sede AND duracion_minutos=p_duration AND activo
 AND deporte=coalesce(nullif(lower(trim(v_court.deporte)),''),'padbol');
 IF v_count=0 THEN
  SELECT count(*),min(precio) INTO v_count,v_price FROM sedes_duraciones
  WHERE sede_id=p_sede AND duracion_minutos=p_duration AND activo AND deporte IS NULL;
 END IF;
 IF v_count<>1 OR v_price IS NULL OR v_price<0 OR v_price<>trunc(v_price) OR v_price>2147483647 THEN
  RAISE EXCEPTION 'pricing_unavailable' USING ERRCODE='55000'; END IF;
 IF v_price<>p_expected_price THEN RAISE EXCEPTION 'price_changed' USING ERRCODE='22023'; END IF;
 INSERT INTO reservas(sede_id,sede,fecha,hora,hora_inicio,cancha,cancha_id,nombre,email,telefono,whatsapp,nivel,user_id,precio,estado,pago_estado,duracion_minutos)
 VALUES(p_sede,v_sede.nombre,p_date,p_time,p_time,v_court.orden,p_court::integer,v_display,v_email,v_telefono,v_whatsapp,v_nivel,p_player,v_price::integer,'pendiente_pago_efectivo','pendiente_cobro',p_duration)
 RETURNING id INTO v_reserva;
 INSERT INTO manual_player_booking_receipts VALUES(p_reference,p_actor,v_payload,v_reserva);
 RETURN jsonb_build_object('id',v_reserva::text,'status','pendiente_pago_efectivo','pago_estado','pendiente_cobro','recuperada',false);
END $$;
REVOKE ALL ON FUNCTION manual_player_booking_candidate(uuid,uuid,uuid,integer,bigint,text,text,integer,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION manual_player_booking_candidate(uuid,uuid,uuid,integer,bigint,text,text,integer,integer,text,text) TO service_role;

-- EXPERIMENTAL cross-occupancy guard. The common transaction lock must be
-- taken by the manual booking and every writer of match/class occupancy.
CREATE OR REPLACE FUNCTION manual_booking_guard_other_occupancy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c clases%ROWTYPE; h clases_horarios%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 IF TG_TABLE_NAME='partidos_abiertos' THEN
  IF lower(coalesce(NEW.estado,'')) IN ('abierto','completo') AND EXISTS (
   SELECT 1 FROM manual_player_booking_receipts receipt JOIN reservas r ON r.id=receipt.reserva_id
   JOIN canchas court ON court.id=r.cancha_id
   WHERE (r.estado IN ('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva') OR (r.estado='suspendida' AND NOT EXISTS (SELECT 1 FROM public.scoreboard_linked_suspend_candidate ss JOIN public.scoreboard_partidos sx ON sx.id=ss.scoreboard_id WHERE ss.booking_id=r.id AND sx.estado='suspendido' AND (sx.reserva_id=r.id OR EXISTS (SELECT 1 FROM public.partidos_abiertos ax WHERE ax.id=sx.partido_abierto_id AND ax.id=ss.open_id AND ax.reserva_id=r.id))))) AND r.sede_id=NEW.sede_id
    AND NOT (current_setting('padbol.linked_suspension_candidate',true) IS NOT DISTINCT FROM '1' AND EXISTS (SELECT 1 FROM scoreboard_linked_suspend_candidate ss WHERE ss.booking_id=r.id AND ss.open_id=NEW.id))
    AND (NEW.cancha_id=r.cancha_id OR trim(NEW.cancha)=court.orden::text OR
       (NEW.cancha_id IS NULL AND coalesce(trim(NEW.cancha),'') !~ '^[0-9]+$'))
    AND (NEW.fecha IS NULL OR (public.reserva_intervalo_guard(NEW.fecha::text,NEW.hora::text,NULL,NEW.duracion_minutos) IS NULL AND NEW.fecha BETWEEN r.fecha::date-1 AND r.fecha::date) OR public.reserva_intervalo_guard(NEW.fecha::text,NEW.hora::text,NULL,NEW.duracion_minutos)
      && public.reserva_intervalo_guard(r.fecha,r.hora,r.hora_inicio,r.duracion_minutos)))
  THEN RAISE EXCEPTION 'manual_booking_conflict' USING ERRCODE='23P01'; END IF;
 ELSIF TG_TABLE_NAME='clases_horarios' THEN
  SELECT * INTO c FROM clases WHERE id=NEW.clase_id;
  IF c.activo AND EXISTS (SELECT 1 FROM manual_player_booking_receipts receipt JOIN reservas r ON r.id=receipt.reserva_id
   WHERE (r.estado IN ('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva') OR (r.estado='suspendida' AND NOT EXISTS (SELECT 1 FROM public.scoreboard_linked_suspend_candidate ss JOIN public.scoreboard_partidos sx ON sx.id=ss.scoreboard_id WHERE ss.booking_id=r.id AND sx.estado='suspendido' AND (sx.reserva_id=r.id OR EXISTS (SELECT 1 FROM public.partidos_abiertos ax WHERE ax.id=sx.partido_abierto_id AND ax.id=ss.open_id AND ax.reserva_id=r.id))))) AND r.sede_id=c.sede_id
    AND upper(public.reserva_intervalo_guard(r.fecha,r.hora,r.hora_inicio,r.duracion_minutos)) > (clock_timestamp() AT TIME ZONE coalesce(nullif((SELECT timezone FROM sedes WHERE id=c.sede_id),''),'America/Argentina/Buenos_Aires'))
    AND (c.cancha_id IS NULL OR c.cancha_id=r.cancha_id)
    AND (extract(dow FROM r.fecha::date)::int=NEW.dia_semana OR ((NEW.hora_fin IS NULL OR NEW.hora_inicio IS NULL OR NEW.hora_fin<=NEW.hora_inicio) AND extract(dow FROM r.fecha::date-1)::int=NEW.dia_semana))
    AND (NEW.hora_inicio IS NULL OR NEW.hora_fin IS NULL OR NEW.hora_fin<=NEW.hora_inicio OR tsrange(r.fecha::date+NEW.hora_inicio,r.fecha::date+NEW.hora_fin,'[)')
       && public.reserva_intervalo_guard(r.fecha,r.hora,r.hora_inicio,r.duracion_minutos)))
  THEN RAISE EXCEPTION 'manual_booking_conflict' USING ERRCODE='23P01'; END IF;
 ELSIF TG_TABLE_NAME='clases' AND NEW.activo THEN
  IF EXISTS (SELECT 1 FROM clases_horarios ch JOIN manual_player_booking_receipts receipt ON true
   JOIN reservas r ON r.id=receipt.reserva_id WHERE ch.clase_id=NEW.id
   AND (r.estado IN ('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva') OR (r.estado='suspendida' AND NOT EXISTS (SELECT 1 FROM public.scoreboard_linked_suspend_candidate ss JOIN public.scoreboard_partidos sx ON sx.id=ss.scoreboard_id WHERE ss.booking_id=r.id AND sx.estado='suspendido' AND (sx.reserva_id=r.id OR EXISTS (SELECT 1 FROM public.partidos_abiertos ax WHERE ax.id=sx.partido_abierto_id AND ax.id=ss.open_id AND ax.reserva_id=r.id))))) AND r.sede_id=NEW.sede_id
   AND upper(public.reserva_intervalo_guard(r.fecha,r.hora,r.hora_inicio,r.duracion_minutos)) > (clock_timestamp() AT TIME ZONE coalesce(nullif((SELECT timezone FROM sedes WHERE id=NEW.sede_id),''),'America/Argentina/Buenos_Aires'))
   AND (NEW.cancha_id IS NULL OR NEW.cancha_id=r.cancha_id)
   AND (extract(dow FROM r.fecha::date)::int=ch.dia_semana OR ((ch.hora_fin IS NULL OR ch.hora_inicio IS NULL OR ch.hora_fin<=ch.hora_inicio) AND extract(dow FROM r.fecha::date-1)::int=ch.dia_semana))
   AND (ch.hora_inicio IS NULL OR ch.hora_fin IS NULL OR ch.hora_fin<=ch.hora_inicio OR tsrange(r.fecha::date+ch.hora_inicio,r.fecha::date+ch.hora_fin,'[)')
      && public.reserva_intervalo_guard(r.fecha,r.hora,r.hora_inicio,r.duracion_minutos)))
  THEN RAISE EXCEPTION 'manual_booking_conflict' USING ERRCODE='23P01'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION manual_booking_guard_other_occupancy() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER manual_booking_guard_matches BEFORE INSERT OR UPDATE ON partidos_abiertos FOR EACH ROW EXECUTE FUNCTION manual_booking_guard_other_occupancy();
CREATE TRIGGER manual_booking_guard_classes BEFORE INSERT OR UPDATE ON clases FOR EACH ROW EXECUTE FUNCTION manual_booking_guard_other_occupancy();
CREATE TRIGGER manual_booking_guard_class_hours BEFORE INSERT OR UPDATE ON clases_horarios FOR EACH ROW EXECUTE FUNCTION manual_booking_guard_other_occupancy();

-- Existing manually-created bookings can later be edited through other routes.
CREATE OR REPLACE FUNCTION manual_booking_guard_booking_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_range tsrange; v_court canchas%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM manual_player_booking_receipts WHERE reserva_id=NEW.id) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.sede_id IS NOT DISTINCT FROM OLD.sede_id AND NEW.cancha_id IS NOT DISTINCT FROM OLD.cancha_id
 AND NEW.cancha IS NOT DISTINCT FROM OLD.cancha AND NEW.fecha IS NOT DISTINCT FROM OLD.fecha
 AND NEW.hora IS NOT DISTINCT FROM OLD.hora AND NEW.hora_inicio IS NOT DISTINCT FROM OLD.hora_inicio AND NEW.hora_fin IS NOT DISTINCT FROM OLD.hora_fin
 AND NEW.duracion_minutos IS NOT DISTINCT FROM OLD.duracion_minutos
 AND lower(coalesce(NEW.estado,'')) IN ('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva')
 AND lower(coalesce(OLD.estado,'')) IN ('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva') THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 IF lower(coalesce(NEW.estado,'')) NOT IN ('pendiente','pendiente_pago_manual','pendiente_pago_efectivo','confirmada','confirmado','prereserva') THEN RETURN NEW; END IF;
 v_range:=public.reserva_intervalo_guard(NEW.fecha,NEW.hora,NEW.hora_inicio,NEW.duracion_minutos);
 SELECT * INTO v_court FROM canchas WHERE id=NEW.cancha_id AND sede_id=NEW.sede_id;
 IF v_range IS NULL OR v_court.id IS NULL THEN RAISE EXCEPTION 'manual_booking_slot_invalid' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM partidos_abiertos p WHERE p.sede_id=NEW.sede_id
 AND NOT (current_setting('padbol.linked_suspension_candidate',true) IS NOT DISTINCT FROM '1' AND EXISTS (SELECT 1 FROM scoreboard_linked_suspend_candidate ss WHERE ss.booking_id=NEW.id AND ss.open_id=p.id))
 AND lower(coalesce(p.estado,'')) IN ('abierto','completo')
 AND (p.cancha_id=NEW.cancha_id OR trim(p.cancha)=v_court.orden::text OR (p.cancha_id IS NULL AND coalesce(trim(p.cancha),'') !~ '^[0-9]+$'))
 AND (p.fecha IS NULL OR (public.reserva_intervalo_guard(p.fecha::text,p.hora::text,NULL,p.duracion_minutos) IS NULL AND p.fecha BETWEEN NEW.fecha::date-1 AND NEW.fecha::date)
 OR public.reserva_intervalo_guard(p.fecha::text,p.hora::text,NULL,p.duracion_minutos) && v_range))
 OR EXISTS(SELECT 1 FROM clases c JOIN clases_horarios h ON h.clase_id=c.id
 WHERE c.sede_id=NEW.sede_id AND c.activo AND (c.cancha_id=NEW.cancha_id OR c.cancha_id IS NULL)
 AND (h.dia_semana=extract(dow FROM NEW.fecha::date)::int OR ((h.hora_fin IS NULL OR h.hora_inicio IS NULL OR h.hora_fin<=h.hora_inicio) AND h.dia_semana=extract(dow FROM NEW.fecha::date-1)::int))
 AND (h.hora_inicio IS NULL OR h.hora_fin IS NULL OR h.hora_fin<=h.hora_inicio OR
 tsrange(NEW.fecha::date+h.hora_inicio,NEW.fecha::date+h.hora_fin,'[)') && v_range))
 THEN RAISE EXCEPTION 'manual_booking_conflict' USING ERRCODE='23P01'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION manual_booking_guard_booking_update() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER manual_booking_guard_update BEFORE UPDATE ON reservas FOR EACH ROW EXECUTE FUNCTION manual_booking_guard_booking_update();
