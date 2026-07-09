# Jugador identidad — Fase 1

## Qué se agregó

- Migración SQL: `docs/sql/jugadores_identidad_migration.sql`
  - Tabla `jugadores_identidad` (PII deportiva, separada de `jugadores_perfil`)
  - Tabla `jugadores_aceptaciones` (términos / privacidad / reglamentos)
- Servicios:
  - `src/jugador/jugadorIdentidadService.js`
  - `src/jugador/jugadorAceptacionesService.js`
  - `src/jugador/jugadorIdentidadCrypto.js` (cifrado opcional vía `IDENTIDAD_ENCRYPTION_KEY`)
- Rutas JWT (solo identidad propia):
  - `GET /api/jugador/identidad`
  - `PUT /api/jugador/identidad`
  - `GET /api/jugador/aceptaciones`
  - `POST /api/jugador/aceptaciones`

## Privacidad

- El número de documento **nunca** se devuelve completo al jugador: solo `numero_documento_masked` y `numero_documento_last4`.
- No se exponen: `numero_documento_hash`, `numero_documento_cifrado`, `identidad_notas_admin`.
- Sin `IDENTIDAD_ENCRYPTION_KEY`, el backend guarda `pending_encryption:v1:…` (no es cifrado fuerte). Configurar clave de 32 bytes (hex 64 chars o base64) en producción.
- No se guarda documento en metadata JSON suelta.

## Endpoints

### GET /api/jugador/identidad

JWT obligatorio. Devuelve ficha de identidad propia con flags `completitud`.

### PUT /api/jugador/identidad

Campos aceptados: `fecha_nacimiento`, `tipo_documento`, `pais_documento`, `numero_documento`, `nacionalidad`, `genero`, `categoria_deportiva`, `telefono`, contacto de emergencia.

Estados:
- `incompleta` — faltan datos mínimos (fecha + documento)
- `pendiente_revision` — documento completo o documento modificado
- `verificada` / `rechazada` — solo admin (Fase 2)

### GET /api/jugador/aceptaciones

Lista aceptaciones del usuario.

### POST /api/jugador/aceptaciones

Body: `{ tipo, version, torneo_id? }`. Tipos: `terminos_servicio`, `privacidad`, `reglamento_torneo`, `padbol_match`. Idempotente por `(user_id, tipo, version, torneo_id)`.

## Qué NO se toca todavía

- Perfil público (`/api/jugador/perfil-publico/*`)
- Endpoints públicos de torneos (`GET /api/torneos/:id/jugadores`, equipos con email)
- Flujo de inscripción a torneos
- Verificación admin de identidad
- Rol organizador de torneo

## Próximos pasos

1. **Fase 2 — Admin**: lectura/verificación identidad, alertas duplicados por hash
2. **Fase 3 — Torneos**: pre-check identidad mínima al inscribir; unique `(torneo_id, user_id)`
3. **Fase 4 — Privacidad torneos**: ocultar emails en respuestas públicas de equipos/jugadores
4. Configurar `IDENTIDAD_ENCRYPTION_KEY` en entorno productivo
5. RLS Supabase como defensa en profundidad (opcional)
