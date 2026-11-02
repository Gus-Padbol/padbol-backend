-- PREFLIGHT SOLO LECTURA. No modifica datos ni muestra contactos/credenciales.
-- El DDL legacy completo no está versionado en la base 04a161e. Revisar salida
-- contra esquema QA autorizado antes de aplicar la migración candidata.
WITH required(table_name,column_name) AS (VALUES
  ('sedes','id'),
  ('sedes','nombre'),
  ('sedes','pais'),
  ('sedes','ciudad'),
  ('sedes','provincia'),
  ('sedes','direccion'),
  ('sedes','timezone'),
  ('sedes','latitud'),
  ('sedes','longitud'),
  ('sedes','horario_apertura'),
  ('sedes','horario_cierre'),
  ('sedes','precio_turno'),
  ('sedes','precio_por_reserva'),
  ('sedes','moneda'),
  ('sedes','metodo_pago'),
  ('sedes','stripe_account_id'),
  ('sedes','mp_access_token'),
  ('sedes','mp_public_key'),
  ('sedes','pago_manual_instrucciones'),
  ('sedes','telefono'),
  ('sedes','email_contacto'),
  ('sedes','cantidad_canchas'),
  ('sedes','numero_licencia'),
  ('sedes','fecha_licencia'),
  ('sedes','licencia_activa'),
  ('sedes','franjas_horarias'),
  ('sedes','fotos_destacadas'),
  ('sedes','whatsapp_contacto'),
  ('sedes_pendientes','id'),
  ('sedes_pendientes','estado'),
  ('sedes_pendientes','nombre'),
  ('sedes_pendientes','licenciatario_email'),
  ('user_roles','user_id'),
  ('user_roles','email'),
  ('user_roles','role'),
  ('user_roles','alcance'),
  ('user_roles','sede_id'),
  ('user_roles','pais'),
  ('user_roles','provincia'),
  ('user_roles','ciudad'),
  ('user_roles','nombre'),
  ('user_roles','torneos_oficiales_habilitados')
)
SELECT r.table_name,r.column_name,c.data_type,c.udt_name,c.is_nullable,
       c.column_default,CASE WHEN c.column_name IS NULL THEN 'MISSING' ELSE 'REVIEW_TYPE' END AS check_status
FROM required r LEFT JOIN information_schema.columns c
 ON c.table_schema='public' AND c.table_name=r.table_name AND c.column_name=r.column_name
ORDER BY r.table_name,r.column_name;
-- Comprobar tipos/PK antes de nuevas FK, sin inspeccionar registros.
SELECT tc.table_name,tc.constraint_name,tc.constraint_type,kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu USING(constraint_catalog,constraint_schema,constraint_name)
WHERE tc.table_schema='public' AND tc.table_name IN ('sedes','sedes_pendientes','user_roles')
ORDER BY tc.table_name,tc.constraint_name,kcu.ordinal_position;
-- Solo conteo agregado de ambigüedades; no extraer correos de usuarios.
SELECT count(*) AS ambiguous_normalized_email_groups FROM (
 SELECT 1 FROM public.user_roles WHERE nullif(btrim(email),'') IS NOT NULL
 GROUP BY lower(btrim(email)) HAVING count(*)>1
) AS ambiguous;
