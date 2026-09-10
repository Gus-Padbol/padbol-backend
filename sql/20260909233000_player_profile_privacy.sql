-- Addendum 11. No profile rows are copied, modified or deleted.
-- Public profile data is served through the backend's explicit public DTO.
BEGIN;

ALTER TABLE public.jugadores_perfil ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.jugadores_perfil FROM anon, PUBLIC, authenticated;
-- Column grants are independent of table grants. Close any historical exception.
DO $$
DECLARE profile_column record;
BEGIN
  FOR profile_column IN
    SELECT attname FROM pg_attribute
    WHERE attrelid = 'public.jugadores_perfil'::regclass AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format('REVOKE ALL (%I) ON TABLE public.jugadores_perfil FROM anon, PUBLIC', profile_column.attname);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON TABLE public.jugadores_perfil TO authenticated;
GRANT ALL ON TABLE public.jugadores_perfil TO service_role;

DROP POLICY IF EXISTS "Lectura pública de perfiles" ON public.jugadores_perfil;
DROP POLICY IF EXISTS "Usuario puede actualizar su perfil" ON public.jugadores_perfil;
DROP POLICY IF EXISTS "Usuario puede crear su perfil" ON public.jugadores_perfil;
DROP POLICY IF EXISTS "Usuario puede ver su perfil" ON public.jugadores_perfil;
DROP POLICY IF EXISTS jugador_insert_propio ON public.jugadores_perfil;
DROP POLICY IF EXISTS jugador_select_propio ON public.jugadores_perfil;
DROP POLICY IF EXISTS jugador_update_propio ON public.jugadores_perfil;
DROP POLICY IF EXISTS service_role_all ON public.jugadores_perfil;

CREATE POLICY player_profile_select_self ON public.jugadores_perfil
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY player_profile_insert_self ON public.jugadores_perfil
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY player_profile_update_self ON public.jugadores_perfil
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY player_profile_service_access ON public.jugadores_perfil
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.jugadores_perfil IS
  'Private player profile. Clients access their own UUID only; public DTOs are served by the authorized backend.';

COMMIT;
