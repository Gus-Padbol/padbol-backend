-- Recovery proposal ONLY before the new feature has any persistent use.
-- Restore the previous compatible backend first; it must not SELECT dropped columns.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.torneos WHERE plan_nations IS NOT NULL) OR EXISTS(SELECT 1 FROM public.torneo_nations_programacion) THEN RAISE EXCEPTION 'Nations data exists: preserve event history, do not drop schema'; END IF;
END $$;
DROP POLICY IF EXISTS nations_equipos_read_guard ON public.equipos;
DROP POLICY IF EXISTS nations_partidos_read_guard ON public.partidos;
DROP POLICY IF EXISTS nations_puntos_read_guard ON public.tabla_puntos;
DROP POLICY IF EXISTS nations_scoreboard_read_guard ON public.scoreboard_partidos;
DROP POLICY IF EXISTS nations_games_read_guard ON public.games;
DROP FUNCTION IF EXISTS public.puede_leer_games_nations(bigint);
DROP POLICY IF EXISTS nations_ranking_jugadores_read_guard ON public.ranking_jugadores;
DROP POLICY IF EXISTS nations_clasificaciones_read_guard ON public.clasificaciones;
DROP FUNCTION IF EXISTS public.puede_leer_equipo_nations(bigint);
DROP FUNCTION IF EXISTS public.puede_leer_nations(bigint,bigint,bigint);
DROP TRIGGER IF EXISTS proteger_plan_nations_torneo ON public.torneos;
DROP TRIGGER IF EXISTS proteger_plan_nations_partido ON public.partidos;
DROP TRIGGER IF EXISTS proteger_marcador_nations ON public.scoreboard_partidos;
DROP TRIGGER IF EXISTS proteger_reserva_nations ON public.reservas;
DROP TRIGGER IF EXISTS proteger_clase_nations ON public.clases;
DROP TRIGGER IF EXISTS proteger_horario_clase_nations ON public.clases_horarios;
DROP FUNCTION IF EXISTS public.guardar_plan_nations(bigint,uuid,text,bigint,uuid,text,jsonb);
DROP FUNCTION IF EXISTS public.exportar_acta_nations(bigint,uuid,bigint);
DROP FUNCTION IF EXISTS public.leer_estado_nations(bigint);
DROP FUNCTION IF EXISTS public.nations_source_snapshot(bigint);
DROP FUNCTION IF EXISTS public.proteger_plan_nations();
DROP FUNCTION IF EXISTS public.proteger_marcador_nations();
DROP FUNCTION IF EXISTS public.proteger_reserva_nations();
DROP FUNCTION IF EXISTS public.proteger_clase_nations();
DROP TABLE public.torneo_nations_programacion;
DROP TABLE public.torneo_nations_planes;
ALTER TABLE public.torneos DROP COLUMN plan_nations;
-- Intentionally keep the config_puntos API write guard; don't reopen unchecked writes.
COMMIT;
