-- LOCAL CANDIDATE ONLY. No grants, data backfill or remote application.
-- Patch current definitions rather than overwriting later suspension safeguards.
BEGIN;
DO $patch$
DECLARE target regprocedure; source text; patched text; ending text; old_predicate text; replacement text; relation text;
BEGIN
 target:=to_regprocedure('public.proteger_marcador_nations()');
 source:=pg_get_functiondef(target);
 IF md5(source) IS DISTINCT FROM 'd42897a3c402060f2a72c3e4e11758ca' THEN RAISE EXCEPTION 'Unreviewed Nations guard fingerprint'; END IF;
 IF source IS NULL OR position($old$m.cancha_id IS NULL AND m.cancha IS NULL AND NEW.cancha IS NULL AND NEW.estado='pendiente'$old$ in source)=0 THEN RAISE EXCEPTION 'Unexpected Nations court guard'; END IF;
 EXECUTE replace(source,$old$m.cancha_id IS NULL AND m.cancha IS NULL AND NEW.cancha IS NULL AND NEW.estado='pendiente'$old$,$new$NEW.cancha IS NULL AND NEW.estado='pendiente' AND NEW.cronometro_inicio IS NULL AND coalesce(NEW.cronometro_segundos,0)=0$new$);
 IF to_regprocedure('public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)') IS NOT NULL
 AND md5(pg_get_functiondef('public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint)'::regprocedure)) IS DISTINCT FROM '11b1bba039497e2094ba7bd3c6577691' THEN RAISE EXCEPTION 'Unreviewed preparation wrapper'; END IF;
 FOREACH target IN ARRAY ARRAY[
  to_regprocedure('public.proteger_cancha_marcador_activo()'),
  coalesce(to_regprocedure('public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)'),
    to_regprocedure('public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint)'))
 ] LOOP
  source:=pg_get_functiondef(target);
  IF source IS NULL THEN RAISE EXCEPTION 'Marker preparation guard missing'; END IF;
  IF md5(source) NOT IN ('022c524f23fd988ce5925dd1835719a5','60842fb20f723cf15736f4f2bfe3720a','c0c75dab49b46cae03f0da686d013eaf','b7ab0f52957aaa68ac74c540486a23f1','3e594ba873b2dca349e9541d17f79edd') THEN RAISE EXCEPTION 'Unreviewed marker function fingerprint'; END IF;
  old_predicate:=NULL;
  FOREACH ending IN ARRAY ARRAY[$states$'terminado','finalizado','cancelado'$states$,$states$'terminado','finalizado','cancelado','suspendido'$states$] LOOP
   replacement:='AND lower(coalesce(s.estado,' || quote_literal('') || ')) NOT IN(' || ending || ')) THEN RAISE EXCEPTION USING ERRCODE=' || quote_literal('23505') || ',MESSAGE=' || quote_literal('Team already using a scoreboard') || ';';
   IF position(replacement in source)>0 THEN old_predicate:=replacement; EXIT; END IF;
  END LOOP;
  IF old_predicate IS NOT NULL AND (length(source)-length(replace(source,old_predicate,'')))/length(old_predicate)<>1 THEN RAISE EXCEPTION 'Ambiguous team guard'; END IF;
  IF old_predicate IS NULL THEN RAISE EXCEPTION 'Unexpected team guard; review current definition'; END IF;
  patched:=replace(source,old_predicate,replace(old_predicate,') THEN RAISE', $add$ AND NOT (s.estado='pendiente' AND s.cancha IS NULL)) THEN RAISE$add$));
  IF target=to_regprocedure('public.proteger_cancha_marcador_activo()') THEN
   IF (length(patched)-length(replace(patched,E'BEGIN\n','')))/length(E'BEGIN\n')<>1 THEN RAISE EXCEPTION 'Unexpected occupancy body'; END IF;
   patched:=replace(patched,E'BEGIN\n', E'BEGIN\n' || $guard$ -- A linked prepared marker must claim a real court before starting. Legacy
 -- controls already running without a court are not retroactively changed.
 IF NEW.partido_torneo_id IS NOT NULL AND NEW.cancha IS NULL
    AND (TG_OP='INSERT' OR OLD.estado='pendiente')
    AND (NEW.estado='en_curso' OR NEW.cronometro_inicio IS NOT NULL OR coalesce(NEW.cronometro_segundos,0)>0) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Activate a court from the tournament match before Start';
 END IF;
$guard$);
   -- Security-definer queries must not resolve attacker-controlled temp tables.
   FOREACH relation IN ARRAY ARRAY['canchas','partidos','torneos','equipos','scoreboard_partidos'] LOOP
    patched:=replace(patched,'FROM '||relation||' ','FROM public.'||relation||' ');
    patched:=replace(patched,'JOIN '||relation||' ','JOIN public.'||relation||' ');
   END LOOP;
  END IF;
  EXECUTE patched;
 END LOOP;
END $patch$;
ALTER FUNCTION public.proteger_cancha_marcador_activo() SET search_path=pg_catalog;
DROP TRIGGER IF EXISTS proteger_cancha_marcador_activo ON public.scoreboard_partidos;
CREATE TRIGGER proteger_cancha_marcador_activo BEFORE INSERT OR UPDATE OF sede_id,cancha,estado,cronometro_inicio,cronometro_segundos,cronometro_pausado ON public.scoreboard_partidos
FOR EACH ROW EXECUTE FUNCTION public.proteger_cancha_marcador_activo();
-- Includes nullable legacy states. Existing ambiguity aborts the migration; no
-- automatic repair or deletion is permitted.
CREATE UNIQUE INDEX idx_scoreboard_bulk_active_match_v2 ON public.scoreboard_partidos(partido_torneo_id)
WHERE partido_torneo_id IS NOT NULL AND lower(trim(coalesce(estado,''))) NOT IN ('terminado','finalizado');
COMMIT;
