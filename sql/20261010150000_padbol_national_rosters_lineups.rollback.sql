-- Safe schema rollback only before use. This does not erase any national records.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.torneos WHERE modalidad_plantel='selecciones')
 OR EXISTS(SELECT 1 FROM public.torneo_partido_alineaciones)
 OR EXISTS(SELECT 1 FROM public.torneo_partido_participacion) THEN
  RAISE EXCEPTION 'Rollback refused: retain national history and use a reviewed forward fix';
 END IF;
END $$;
DROP TRIGGER IF EXISTS proteger_selecciones_torneos ON public.torneos;
DROP TRIGGER IF EXISTS proteger_selecciones_equipos ON public.equipos;
DROP TRIGGER IF EXISTS proteger_selecciones_resultado ON public.partidos;
DO $$ BEGIN
 IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN DROP TRIGGER IF EXISTS proteger_selecciones_marcador ON public.scoreboard_partidos; END IF;
 IF to_regclass('public.partido_fecha_juego') IS NOT NULL THEN DROP TRIGGER IF EXISTS proteger_selecciones_fecha_legacy ON public.partido_fecha_juego; END IF;
END $$;
DROP TABLE public.torneo_partido_participacion;
DROP TABLE public.torneo_partido_alineaciones;
DROP FUNCTION public.guardar_alineacion_seleccion(bigint,bigint,bigint,uuid,boolean,uuid[],uuid[],bigint);
DROP FUNCTION public.guardar_plantel_seleccion(bigint,bigint,uuid,boolean,text,text,integer,boolean,uuid[],bigint);
DROP FUNCTION public.finalizar_torneo_seleccion(bigint,uuid,jsonb);
DROP FUNCTION public.finalizar_partido_seleccion(bigint,jsonb,uuid,text);
DROP FUNCTION public.proteger_planteles_selecciones();
DROP FUNCTION public.proteger_resultado_seleccion();
DROP FUNCTION public.proteger_marcador_seleccion();
DROP FUNCTION public.proteger_fecha_legacy_seleccion();
ALTER TABLE public.torneos DROP CONSTRAINT torneos_modalidad_plantel_check;
ALTER TABLE public.torneos DROP COLUMN modalidad_plantel;
ALTER TABLE public.equipos DROP COLUMN plantel_revision;
ALTER TABLE public.equipos DROP COLUMN modalidad_plantel;
ALTER TABLE public.equipos DROP COLUMN participantes_ranking;
COMMIT;
