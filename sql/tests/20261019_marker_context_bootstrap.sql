-- Extend the 20261016 isolated bootstrap only; no application to a live database.
ALTER TABLE torneos ADD COLUMN modalidad_plantel text,ADD COLUMN nivel_torneo text,ADD COLUMN horas_revelar_equipos integer;
ALTER TABLE partidos ADD COLUMN resultado jsonb,ADD COLUMN ganador_equipo_id bigint;
ALTER TABLE scoreboard_partidos ADD COLUMN sede_id bigint,ADD COLUMN equipo_a_jugadores jsonb,ADD COLUMN equipo_b_jugadores jsonb,ADD COLUMN sets_a integer,ADD COLUMN sets_b integer,ADD COLUMN historial_sets jsonb,ADD COLUMN sync_torneo_status text,ADD COLUMN synced_to_torneo_at timestamptz;
CREATE TABLE torneo_partido_alineaciones(partido_id bigint,equipo_id bigint,iniciales uuid[],suplentes uuid[]);
CREATE TABLE torneo_partido_participacion(partido_id bigint);
CREATE TABLE torneo_nations_planes(torneo_id bigint,plan jsonb);
