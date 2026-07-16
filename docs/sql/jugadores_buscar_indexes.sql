-- Índices opcionales para búsqueda pública de jugadores (ILIKE / lower).
-- Idempotente. NO obligatorio para el endpoint GET /api/jugadores/buscar.
-- Mejora rendimiento en catálogos grandes. Aplicar en Supabase cuando convenga.

CREATE INDEX IF NOT EXISTS idx_jugadores_perfil_nombre_lower
  ON public.jugadores_perfil (lower(nombre));

CREATE INDEX IF NOT EXISTS idx_jugadores_perfil_apellido_lower
  ON public.jugadores_perfil (lower(apellido));

CREATE INDEX IF NOT EXISTS idx_jugadores_perfil_apodo_lower
  ON public.jugadores_perfil (lower(apodo));

-- username ya puede tener idx_jugadores_perfil_username_lower (perfil_migration).
CREATE INDEX IF NOT EXISTS idx_jugadores_perfil_username_lower
  ON public.jugadores_perfil (lower(username));

CREATE INDEX IF NOT EXISTS idx_jugadores_perfil_alias_lower
  ON public.jugadores_perfil (lower(alias));

CREATE INDEX IF NOT EXISTS idx_jugadores_perfil_user_id
  ON public.jugadores_perfil (user_id)
  WHERE user_id IS NOT NULL;
