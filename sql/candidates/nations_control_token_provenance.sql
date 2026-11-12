-- ROOT reviewed additive provenance only; QA first. No backfill, role grants or global hooks.
BEGIN;
DO $gate$ BEGIN
 IF to_regclass('nations_marker_private.nations_marker_match') IS NULL OR to_regclass('nations_marker_private.games_finalization_intents') IS NULL THEN RAISE EXCEPTION 'Reviewed games core prerequisite missing'; END IF;
 IF to_regclass('nations_marker_private.nations_control_token_issuer') IS NOT NULL THEN RAISE EXCEPTION 'Provenance table already exists: reconcile exact postimage, do not retry blindly'; END IF;
END $gate$;
CREATE TABLE nations_marker_private.nations_control_token_issuer(
 scoreboard_id uuid NOT NULL REFERENCES public.scoreboard_partidos(id),
 token_hash text NOT NULL CHECK(token_hash~'^[a-f0-9]{64}$'),
 issuer_user_id uuid NOT NULL REFERENCES auth.users(id),
 issued_at timestamptz NOT NULL,
 PRIMARY KEY(scoreboard_id,token_hash)
);
ALTER TABLE nations_marker_private.nations_control_token_issuer ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nations_marker_private.nations_control_token_issuer FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER nations_control_issuer_immutable BEFORE UPDATE OR DELETE ON nations_marker_private.nations_control_token_issuer FOR EACH ROW EXECUTE FUNCTION nations_marker_private.nations_marker_audit_immutable();
CREATE TRIGGER nations_control_issuer_no_truncate BEFORE TRUNCATE ON nations_marker_private.nations_control_token_issuer FOR EACH STATEMENT EXECUTE FUNCTION nations_marker_private.nations_marker_audit_no_truncate();
COMMIT;
