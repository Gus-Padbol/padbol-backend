BEGIN;
DROP TRIGGER IF EXISTS proteger_cancha_marcador_activo ON public.scoreboard_partidos;
DROP FUNCTION IF EXISTS public.proteger_cancha_marcador_activo();
DROP FUNCTION IF EXISTS public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint);
COMMIT;
