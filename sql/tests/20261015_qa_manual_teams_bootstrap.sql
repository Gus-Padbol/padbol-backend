CREATE SCHEMA auth;
CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.sedes(id bigint PRIMARY KEY);
CREATE TABLE public.torneos(id bigint PRIMARY KEY,sede_id bigint REFERENCES sedes,es_prueba boolean,deporte text,modalidad_plantel text,formato_equipo text,plan_nations jsonb,estado text,tipo_torneo text,costo_inscripcion numeric,inscripcion_monto numeric);
CREATE TABLE public.user_roles(user_id uuid PRIMARY KEY REFERENCES auth.users,role text,sede_id bigint);
CREATE TABLE public.jugadores_perfil(user_id uuid PRIMARY KEY REFERENCES auth.users,nombre text,apellido text,fecha_nacimiento date);
CREATE TABLE public.partidos(id bigserial PRIMARY KEY,torneo_id bigint REFERENCES torneos,sede_id bigint,equipo_a_id bigint,equipo_b_id bigint,estado text,grupo text,ronda integer,bracket_round integer,bracket_position integer,partido_siguiente_id bigint,partido_siguiente_slot text);
CREATE TABLE public.equipos(id bigserial PRIMARY KEY,torneo_id bigint REFERENCES torneos,sede_id bigint,nombre text,creador_id uuid REFERENCES auth.users,jugadores jsonb,solicitudes jsonb,cupo_maximo integer,equipo_abierto boolean,tipo_equipo text,inscripcion_estado text,modalidad_plantel text);
