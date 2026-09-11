-- Candidate: isolate public venue reads from private provider configuration.
-- Coordinator assigns the migration version after destination metadata preflight.
-- READ grants only. Keep all current RLS policies and INSERT/UPDATE/DELETE grants.
-- Does not change stored values, XP, pricing, identities, or provider configuration.
BEGIN;
REVOKE SELECT ON TABLE public.sedes FROM PUBLIC, anon, authenticated;
DO $$ DECLARE col record; BEGIN
  FOR col IN SELECT attname FROM pg_attribute
    WHERE attrelid = 'public.sedes'::regclass AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format('REVOKE SELECT (%I) ON TABLE public.sedes FROM PUBLIC, anon, authenticated', col.attname);
  END LOOP;
END $$;
GRANT SELECT (id, nombre, direccion, ciudad, provincia, pais, telefono, email_contacto, horario_apertura, horario_cierre, moneda, metodo_pago, pago_manual_instrucciones, precio_60min, precio_90min, precio_120min, precio_turno, precio_por_reserva, cantidad_canchas, duracion_reserva_minutos, latitud, longitud, foto_url, foto_portada, fotos_urls, fotos_destacadas, logo_url, descripcion, slogan, historia, amenities, deportes_disponibles, instagram, facebook, tiktok, twitter, youtube, website, color_fondo_logo, color_hero_primario, color_hero_secundario, color_borde_hero, surge_activo, surge_precio_minimo, surge_precio_maximo)
  ON TABLE public.sedes TO anon, authenticated;
-- Fail closed if an unexpected inherited grant still exposes a private column.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles r CROSS JOIN pg_attribute a
    WHERE r.rolname IN ('anon','authenticated')
      AND a.attrelid='public.sedes'::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname <> ALL (ARRAY['id','nombre','direccion','ciudad','provincia','pais','telefono','email_contacto','horario_apertura','horario_cierre','moneda','metodo_pago','pago_manual_instrucciones','precio_60min','precio_90min','precio_120min','precio_turno','precio_por_reserva','cantidad_canchas','duracion_reserva_minutos','latitud','longitud','foto_url','foto_portada','fotos_urls','fotos_destacadas','logo_url','descripcion','slogan','historia','amenities','deportes_disponibles','instagram','facebook','tiktok','twitter','youtube','website','color_fondo_logo','color_hero_primario','color_hero_secundario','color_borde_hero','surge_activo','surge_precio_minimo','surge_precio_maximo'])
      AND has_column_privilege(r.oid,a.attrelid,a.attnum,'SELECT')
  ) THEN RAISE EXCEPTION 'Private venue read remains through another grant; inspect role inheritance before installing';
  END IF;
END $$;
COMMIT;
