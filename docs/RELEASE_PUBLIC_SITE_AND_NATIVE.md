# Salida coordinada: web pública, backend y app nativa

Esta guía cubre los cambios del rediseño público, las solicitudes de clubes y
la eliminación de cuenta. El orden es importante: la web y la app ya incluyen
funciones que dependen de tablas y rutas nuevas del backend.

## 1. Requisitos previos

- Acceso al proyecto correcto de Supabase.
- Acceso al servicio de producción del backend.
- Acceso al hosting de `padbolmatch.com`.
- Sesión válida de GitHub CLI (`gh auth status`).
- Sesión válida de Expo/EAS (`eas whoami`).
- Para iOS: organización Apple activa y datos societarios/D-U-N-S aprobados.

No incluir secretos, tokens, credenciales ni archivos `.env` en commits,
capturas o tickets.

## 2. Migraciones de base de datos

Ejecutar una sola vez, en este orden, desde el editor SQL de Supabase:

1. `docs/sql/account_deletion_requests.sql`
2. `docs/sql/license_requests.sql`

Verificar que existan:

```sql
select to_regclass('public.account_deletion_requests');
select to_regclass('public.solicitudes_licencia');
```

Ambas consultas deben devolver el nombre de la tabla. Las tablas tienen RLS
activo y no conceden acceso directo a `anon` ni `authenticated`; el acceso se
realiza únicamente mediante el backend.

## 3. Publicar el backend

Publicar el commit que contiene:

- `POST /api/usuarios/eliminacion-cuenta`
- `POST /api/solicitudes-licencia`
- rutas administrativas de roles, sedes, alertas y solicitudes

Comprobar primero la ruta de salud ya utilizada por el servicio. Luego ejecutar
pruebas de humo contra la URL real:

```bash
curl -i -X POST "$API_BASE_URL/api/solicitudes-licencia" \
  -H 'Content-Type: application/json' \
  --data '{
    "club_nombre":"Prueba de publicación",
    "pais":"Argentina",
    "ciudad":"Buenos Aires",
    "responsable_nombre":"Control técnico",
    "email":"qa+release@padbolmatch.com"
  }'
```

Resultado esperado: `201`. Eliminar o marcar como prueba el registro creado.

La eliminación de cuenta exige un token real del titular:

```bash
curl -i -X POST "$API_BASE_URL/api/usuarios/eliminacion-cuenta" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"source":"native","confirmation":"ELIMINAR"}'
```

Resultado esperado: `202`, tanto para una solicitud nueva como para actualizar
una solicitud previa del mismo titular. No copiar el token en documentación ni
historial compartido.

Con una sesión de Super Admin, comprobar que respondan sin `404`:

- `GET /api/admin/sedes-alcance`
- `GET /api/admin/roles`
- `GET /api/admin/alertas-campanita`
- `GET /api/admin/solicitudes-licencia`

## 4. Publicar la web

Publicar la rama del rediseño únicamente después de validar el backend.

Pruebas mínimas:

- Inicio público en escritorio y móvil.
- Navegación, selector de idioma, acceso y llamados a la acción.
- Formulario para incorporar un club.
- `https://padbolmatch.com/privacidad`
- `https://padbolmatch.com/eliminar-cuenta`
- Inicio de sesión Super Admin y carga de sedes, roles, alertas y solicitudes.
- Íconos, manifest, service worker y actualización sin caché obsoleta.

## 5. Generar y probar la app nativa

Generar binarios nuevos después de publicar backend y web. Un binario anterior
no contiene los últimos cambios aunque tenga la misma versión comercial.

Android:

```bash
cd /Users/Padbol-Match-Desarrollo/padbol-match-native
eas build --platform android --profile production
```

iOS, cuando la cuenta Apple esté habilitada:

```bash
cd /Users/Padbol-Match-Desarrollo/padbol-match-native
eas build --platform ios --profile production
```

Antes de enviar a revisión, probar en un dispositivo real:

- registro, ingreso, cierre y recuperación de sesión;
- permisos y notificaciones;
- navegación principal y perfiles;
- flujos de jugador, club y Super Admin disponibles;
- solicitud de eliminación de cuenta;
- textos de eliminación en español, inglés, portugués, italiano, francés,
  alemán, rumano y árabe;
- funcionamiento con red lenta, sin red y tras reabrir la aplicación.

## 6. Fichas de las tiendas

Google Play:

- URL de política: `https://padbolmatch.com/privacidad`
- URL externa de eliminación: `https://padbolmatch.com/eliminar-cuenta`
- declarar los datos realmente recolectados y compartidos;
- usar el AAB generado desde el commit final.

App Store:

- URL de política: `https://padbolmatch.com/privacidad`
- explicar al revisor dónde iniciar la eliminación dentro de Perfil;
- proporcionar una cuenta de revisión funcional si hay contenido protegido;
- completar App Privacy según el comportamiento real de producción.

## 7. Operación de solicitudes de eliminación

El endpoint registra una solicitud; no ejecuta un borrado irreversible
automático. Hasta disponer de un proceso auditado, tratar la cola manualmente:

1. Cambiar `pending` a `processing`.
2. Confirmar identidad, alcance y obligaciones de conservación.
3. Identificar datos propios y relaciones que deban anonimizarse.
4. Anonimizar o eliminar datos de aplicación sin romper historiales legales,
   deportivos o financieros que deban conservarse.
5. Eliminar la identidad de autenticación al final.
6. Marcar `completed`, registrar `completed_at` y una nota sin datos sensibles.

No automatizar el borrado total hasta revisar todas las claves foráneas,
historiales, comprobantes y requisitos legales.

## 8. Criterio de cierre

La salida está completa cuando:

- migraciones aplicadas;
- backend, web y app publicados desde commits identificables;
- pruebas de humo superadas;
- páginas legales accesibles sin sesión;
- solicitud de eliminación creada desde web y app;
- panel administrativo sin rutas faltantes;
- binarios instalados y probados en dispositivos reales;
- enlaces y declaraciones de las tiendas completados.
