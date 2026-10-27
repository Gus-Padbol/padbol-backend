CREATE SCHEMA auth;

CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.sedes(id bigint PRIMARY KEY);
CREATE TABLE public.torneos(id bigint PRIMARY KEY,sede_id bigint REFERENCES sedes,es_prueba boolean,deporte text,modalidad_plantel text,formato_equipo text,plan_nations jsonb,estado text,tipo_torneo text,costo_inscripcion numeric,inscripcion_monto numeric);
CREATE TABLE public.user_roles(user_id uuid PRIMARY KEY REFERENCES auth.users,role text,sede_id bigint);
CREATE TABLE public.jugadores_perfil(user_id uuid PRIMARY KEY REFERENCES auth.users,nombre text,apellido text,fecha_nacimiento date);
CREATE TABLE public.partidos(id bigserial PRIMARY KEY,torneo_id bigint REFERENCES torneos,sede_id bigint,equipo_a_id bigint,equipo_b_id bigint,estado text,grupo text,ronda integer,bracket_round integer,bracket_position integer,partido_siguiente_id bigint,partido_siguiente_slot text);
CREATE TABLE public.equipos(id bigserial PRIMARY KEY,torneo_id bigint REFERENCES torneos,sede_id bigint,nombre text,creador_id uuid REFERENCES auth.users,jugadores jsonb,solicitudes jsonb,cupo_maximo integer,equipo_abierto boolean,tipo_equipo text,inscripcion_estado text,modalidad_plantel text);

CREATE TABLE public.scoreboard_partidos(id bigserial PRIMARY KEY,partido_torneo_id bigint REFERENCES partidos(id));
CREATE TABLE public.tabla_puntos(id bigserial PRIMARY KEY,torneo_id bigint,equipo_id bigint,puntos numeric);
INSERT INTO public.sedes VALUES(8),(9);
INSERT INTO public.torneos VALUES(555,8,true,'padbol','dobles','dobles',NULL,'abierto','knockout',0,0),(556,9,true,'padbol','dobles','dobles',NULL,'abierto','knockout',0,0),(557,8,false,'padbol','dobles','dobles',NULL,'abierto','knockout',0,0);
INSERT INTO auth.users VALUES('11111111-1111-4111-8111-111111111111','{}'),('99999999-9999-4999-8999-999999999999','{}'),('88888888-8888-4888-8888-888888888888','{}');
INSERT INTO public.user_roles VALUES('11111111-1111-4111-8111-111111111111','admin_club',8),('99999999-9999-4999-8999-999999999999','admin_club',9),('88888888-8888-4888-8888-888888888888','admin_club',NULL);
INSERT INTO auth.users SELECT ('22222222-2222-4222-8222-'||lpad(i::text,12,'0'))::uuid,jsonb_build_object('qa_test',true,'qa_torneo_id',555,'qa_sede_id',8) FROM generate_series(1,8) i;
INSERT INTO public.jugadores_perfil SELECT id,'QA Chivi '||right(id::text,2),'Prueba','1990-01-01'::date FROM auth.users WHERE id::text LIKE '22222222%';

ALTER TABLE public.torneos ADD COLUMN nivel_torneo text,ADD COLUMN fipa_registration_enabled boolean,ADD COLUMN fipa_required_fields jsonb;

ALTER TABLE torneos ADD COLUMN fecha_inicio date DEFAULT '2026-10-16',ADD COLUMN fecha_fin date DEFAULT '2026-11-22',ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE sedes ADD COLUMN nombre text DEFAULT 'QA',ADD COLUMN timezone text DEFAULT 'Europe/Rome';
ALTER TABLE jugadores_perfil ADD COLUMN email text;
ALTER TABLE equipos ADD COLUMN puntos_ranking numeric;
ALTER TABLE partidos ADD COLUMN resultado jsonb,ADD COLUMN ganador_equipo_id bigint,ADD COLUMN fecha_hora timestamp,ADD COLUMN cancha_id bigint,ADD COLUMN cancha text;
ALTER TABLE scoreboard_partidos ADD COLUMN torneo_id bigint,ADD COLUMN estado text DEFAULT 'pendiente',ADD COLUMN cancha text,ADD COLUMN equipo_a_jugadores jsonb,ADD COLUMN equipo_b_jugadores jsonb;
ALTER TABLE tabla_puntos ADD COLUMN posicion integer,ADD CONSTRAINT unique_torneo_team UNIQUE(torneo_id,equipo_id);
CREATE TABLE canchas(id bigint PRIMARY KEY,sede_id bigint,nombre text,deporte text,estado text,orden integer);
CREATE TABLE torneo_nations_programacion(partido_id bigint,torneo_id bigint,court_id bigint,inicio timestamptz,duration_minutes integer);
CREATE TABLE reservas(id bigint PRIMARY KEY,sede_id bigint,sede text,cancha integer,estado text,fecha text,hora text,duracion_minutos integer);
CREATE TABLE clases(id bigint PRIMARY KEY,cancha_id bigint,activo boolean);
CREATE TABLE clases_horarios(clase_id bigint,dia_semana integer,hora_inicio time,hora_fin time);
INSERT INTO canchas VALUES(13,8,'Cancha1','padbol','activa',1);
