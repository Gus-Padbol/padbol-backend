-- LOCAL CANDIDATE ONLY. Never confirms payment or grants access.
-- Preserve the installed function's guards and ACL rather than replaying an old definition.
BEGIN;
DO $candidate$
DECLARE
  target regprocedure := to_regprocedure('public.gestionar_participantes_torneo(bigint,uuid,text,jsonb)');
  definition text;
  previous text := 'VALUES(t.id,t.sede_id,trim(p_payload->>''nombre''),p_actor_id,roster,''[]''::jsonb,lim_max,false,''cerrado'',''confirmado'',mode) RETURNING * INTO e;';
  replacement text := '/* canonical_enrollment_pending_v1 */ VALUES(t.id,t.sede_id,trim(p_payload->>''nombre''),p_actor_id,roster,''[]''::jsonb,lim_max,false,''cerrado'',''pendiente'',mode) RETURNING * INTO e;';
BEGIN
  IF target IS NULL THEN RAISE EXCEPTION 'Canonical registration function missing; inspect before applying candidate'; END IF;
  definition := pg_get_functiondef(target);
  IF position('canonical_enrollment_pending_v1' IN definition) > 0 THEN
    IF position(replacement IN definition) = 0 THEN RAISE EXCEPTION 'Candidate marker exists but pending insert differs'; END IF;
    RETURN;
  END IF;
  IF (length(definition)-length(replace(definition,previous,'')))/length(previous) <> 1 THEN
    RAISE EXCEPTION 'Canonical registration body differs; candidate not applicable';
  END IF;
  EXECUTE replace(definition,previous,replacement);
END $candidate$;
COMMIT;
