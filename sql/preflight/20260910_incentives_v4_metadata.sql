-- PREPARADO, NO EJECUTADO. Sólo metadatos de QA; ninguna fila de usuarios.
-- Conexión y TLS deben confirmar vxikhdulhuvghfqeutnp antes de ejecutar.
begin read only;
with required(table_name,column_name) as (values
  ('canchas','deporte'),
  ('canchas','estado'),
  ('canchas','id'),
  ('canchas','sede_id'),
  ('equipos','id'),
  ('equipos','inscripcion_estado'),
  ('equipos','jugadores'),
  ('equipos','torneo_id'),
  ('jugadores_perfil','id'),
  ('jugadores_perfil','user_id'),
  ('partidos','equipo_a_id'),
  ('partidos','equipo_b_id'),
  ('partidos','estado'),
  ('partidos','ganador_equipo_id'),
  ('partidos','id'),
  ('partidos','grupo'),
  ('partidos','bracket_round'),
  ('partidos','bracket_position'),
  ('partidos','partido_siguiente_id'),
  ('partidos','partido_siguiente_slot'),
  ('partidos','resultado'),
  ('partidos','sede_id'),
  ('partidos','torneo_id'),
  ('reservas','origen_creacion'), -- nueva migración candidata, no existente por inferencia
  ('reservas','checkin_at'),
  ('reservas','checkin_realizado'),
  ('reservas','deporte'),
  ('reservas','estado'),
  ('reservas','fecha'),
  ('reservas','id'),
  ('reservas','sede_id'),
  ('reservas','user_id'),
  ('scoreboard_historial_puntos','equipo'),
  ('scoreboard_historial_puntos','id'),
  ('scoreboard_historial_puntos','partido_id'),
  ('scoreboard_historial_puntos','timestamp'),
  ('scoreboard_historial_puntos','score_a_antes'),
  ('scoreboard_historial_puntos','score_b_antes'),
  ('scoreboard_historial_puntos','set_numero'),
  ('scoreboard_historial_puntos','games_a_antes'),
  ('scoreboard_historial_puntos','games_b_antes'),
  ('scoreboard_historial_puntos','sets_a_antes'),
  ('scoreboard_historial_puntos','sets_b_antes'),
  ('scoreboard_historial_puntos','es_tiebreak_antes'),
  ('scoreboard_historial_puntos','estado_antes'),
  ('scoreboard_historial_puntos','historial_sets_antes'),
  ('scoreboard_historial_puntos','saque_actual_antes'),
  ('scoreboard_partidos','estado'),
  ('scoreboard_partidos','historial_sets'),
  ('scoreboard_partidos','id'),
  ('scoreboard_partidos','partido_torneo_id'),
  ('scoreboard_partidos','sede_id'),
  ('scoreboard_partidos','sets_a'),
  ('scoreboard_partidos','sets_b'),
  ('scoreboard_partidos','sync_torneo_status'),
  ('scoreboard_partidos','synced_to_torneo_at'),
  ('scoreboard_partidos','torneo_id'),
  ('scoreboard_partidos','updated_at'),
  ('sede_beneficio_progreso','id'),
  ('sede_beneficio_progreso','periodo'),
  ('sede_beneficio_progreso','programa_id'),
  ('sede_jugadores','estado'),
  ('sede_jugadores','id'),
  ('sede_jugadores','sede_id'),
  ('sede_jugadores','user_id'),
  ('sede_programas_beneficios','codigo'),
  ('sede_programas_beneficios','configuracion'),
  ('sede_programas_beneficios','estado'),
  ('sede_programas_beneficios','fecha_fin_base'),
  ('sede_programas_beneficios','fecha_inicio'),
  ('sede_programas_beneficios','id'),
  ('sede_programas_beneficios','meses_base'),
  ('sede_programas_beneficios','reglas_version'),
  ('sede_programas_beneficios','sede_id'),
  ('sede_programas_beneficios','updated_at'),
  ('sedes','id'),
  ('sedes','stripe_subscription_id'),
  ('torneos','tipo_torneo'),
  ('torneos','deporte'),
  ('torneos','estado'),
  ('torneos','fecha_fin'),
  ('torneos','formato_equipo'),
  ('torneos','id'),
  ('torneos','sede_id')
)
select r.table_name, r.column_name, (c.column_name is not null) as present, c.data_type
from required r left join information_schema.columns c
  on c.table_schema='public' and c.table_name=r.table_name and c.column_name=r.column_name
order by r.table_name, r.column_name;

select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid=to_regclass('public.sede_programas_beneficios')
  and contype in ('u','c','f');
-- Revisar el cuerpo del trigger vigente: sólo estado activo puede cambiar plan.
select t.tgname, pg_get_triggerdef(t.oid) as definition, pg_get_functiondef(t.tgfoid) as function_definition
from pg_trigger t where t.tgrelid=to_regclass('public.sede_programas_beneficios') and not t.tgisinternal;
-- This reports the role of THIS connection. A management/CLI role alone
-- does not prove which role the actual backend pool or PostgREST uses.
select current_user as connection_role, session_user as login_role;
select t.tgname, pg_get_triggerdef(t.oid) as definition, pg_get_functiondef(t.tgfoid) as function_definition
from pg_trigger t where t.tgrelid=to_regclass('public.reservas')
  and t.tgname='proteger_reserva_origen_creacion' and not t.tgisinternal;
rollback;
