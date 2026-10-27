-- After selection_integrated bootstrap + original national DDL + 1400 + 1600.
ALTER TABLE torneos ADD COLUMN horas_revelar_equipos integer DEFAULT 24;
DROP TABLE torneo_nations_programacion;
CREATE TABLE games(id bigint,partido_id bigint);
CREATE TABLE ranking_jugadores(id bigint,equipo_id bigint);
CREATE TABLE clasificaciones(id bigint,equipo_id bigint);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;

ALTER TABLE scoreboard_partidos ADD COLUMN sets_a integer,ADD COLUMN sets_b integer,ADD COLUMN historial_sets jsonb,ADD COLUMN sync_torneo_status text,ADD COLUMN synced_to_torneo_at timestamptz;
