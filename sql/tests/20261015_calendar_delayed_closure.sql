-- Run only in a disposable PostgreSQL database; bootstrap is intentionally minimal.
CREATE TABLE public.sedes(id bigint PRIMARY KEY,timezone text);
CREATE TABLE public.torneos(id bigint PRIMARY KEY,sede_id bigint,plan_nations jsonb,tipo_torneo text,estado text,fecha_inicio date,fecha_fin date,es_prueba boolean DEFAULT false);
CREATE TABLE public.partidos(id bigint PRIMARY KEY,torneo_id bigint,estado text,ganador_equipo_id bigint,bracket_round int,partido_siguiente_id bigint);
CREATE TABLE public.scoreboard_partidos(id bigint PRIMARY KEY,torneo_id bigint,sede_id bigint,partido_torneo_id bigint,estado text,sync_torneo_status text,synced_to_torneo_at timestamptz);
CREATE FUNCTION public.protect_torneo_qa_marker() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
