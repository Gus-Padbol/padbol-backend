-- Backend must be reverted first. Retains all markers, tokens and audit rows.
-- Reverses only this patch; later suspension predicates and qualification remain.
BEGIN;
DO $patch$
DECLARE target regprocedure; source text; patched text; relation text;
BEGIN
 target:=to_regprocedure('public.proteger_marcador_nations()');source:=pg_get_functiondef(target);
 IF position($new$NEW.cancha IS NULL AND NEW.estado='pendiente' AND NEW.cronometro_inicio IS NULL AND coalesce(NEW.cronometro_segundos,0)=0$new$ in source)=0 THEN RAISE EXCEPTION 'Unexpected Nations preparation guard'; END IF;
 EXECUTE replace(source,$new$NEW.cancha IS NULL AND NEW.estado='pendiente' AND NEW.cronometro_inicio IS NULL AND coalesce(NEW.cronometro_segundos,0)=0$new$,$old$m.cancha_id IS NULL AND m.cancha IS NULL AND NEW.cancha IS NULL AND NEW.estado='pendiente'$old$);

 FOREACH target IN ARRAY ARRAY[to_regprocedure('public.proteger_cancha_marcador_activo()'),coalesce(to_regprocedure('public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)'),to_regprocedure('public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint)'))] LOOP
 source:=pg_get_functiondef(target);
 IF position($added$ AND NOT (s.estado='pendiente' AND s.cancha IS NULL)$added$ in source)=0 THEN RAISE EXCEPTION 'Unexpected team preparation guard'; END IF;
 patched:=replace(source,$added$ AND NOT (s.estado='pendiente' AND s.cancha IS NULL)$added$,'');
 patched:=replace(patched,$guard$ -- A linked prepared marker must claim a real court before starting. Legacy
 -- controls already running without a court are not retroactively changed.
 IF NEW.partido_torneo_id IS NOT NULL AND NEW.cancha IS NULL
    AND (TG_OP='INSERT' OR OLD.estado='pendiente')
    AND (NEW.estado='en_curso' OR NEW.cronometro_inicio IS NOT NULL OR coalesce(NEW.cronometro_segundos,0)>0) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Activate a court from the tournament match before Start';
 END IF;
$guard$,'');
 IF target=to_regprocedure('public.proteger_cancha_marcador_activo()') THEN
  FOREACH relation IN ARRAY ARRAY['canchas','partidos','torneos','equipos','scoreboard_partidos'] LOOP
   patched:=replace(patched,'FROM public.'||relation||' ','FROM '||relation||' ');
   patched:=replace(patched,'JOIN public.'||relation||' ','JOIN '||relation||' ');
  END LOOP;
  patched:=replace(patched, $config$SET search_path TO 'pg_catalog'$config$, $config$SET search_path TO 'pg_catalog', 'public'$config$);
 END IF;
 IF md5(patched) NOT IN ('022c524f23fd988ce5925dd1835719a5','60842fb20f723cf15736f4f2bfe3720a','c0c75dab49b46cae03f0da686d013eaf','b7ab0f52957aaa68ac74c540486a23f1','3e594ba873b2dca349e9541d17f79edd') THEN RAISE EXCEPTION 'Rollback preimage mismatch'; END IF;
 EXECUTE patched;
 END LOOP;
END $patch$;
DROP TRIGGER IF EXISTS proteger_cancha_marcador_activo ON public.scoreboard_partidos;
CREATE TRIGGER proteger_cancha_marcador_activo BEFORE INSERT OR UPDATE OF sede_id,cancha,estado ON public.scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION public.proteger_cancha_marcador_activo();
DROP INDEX public.idx_scoreboard_bulk_active_match_v2;
COMMIT;
