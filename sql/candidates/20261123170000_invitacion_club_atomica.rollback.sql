-- Rollback for 20261123170000_invitacion_club_atomica.sql (candidate).
-- Non-destructive for data: only drops the atomic routine. No table, column,
-- row, constraint, trigger or role change is reverted because the candidate
-- created none.
--
-- Deployment note: once the route calls this routine, dropping it makes the
-- CLUB invite completion fail closed with HTTP 503
-- INVITACION_ATOMIC_RPC_UNAVAILABLE (retry:false). There is intentionally no
-- non-atomic REST fallback. To disable the feature safely, revert the route
-- delta together with this drop, or leave the routine deployed.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.completar_invitacion_club_atomica(text, text, text, jsonb, jsonb);
COMMIT;
