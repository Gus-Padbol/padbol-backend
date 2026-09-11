# Configuración privada de sedes: paquete local mínimo

## Estado y límites

Candidato aislado: `/private/tmp/padbol-director2-security-20260910`. Sólo protección de lectura/DTO y compatibilidad de clientes. No desplegado ni aplicado en QA/producción. No APK/AAB, EAS, pagos, mensajes o valores privados reales.

El parche backend se genera contra QA `6b9b60ad3da4d3e5052ba1f3157e31496600dbf4`, fuente de sólo lectura `/private/tmp/padbol-whatsapp-qa-scoped-send-20260910`. El paquete detenido anterior se copió y verificó mediante `snapshot-hashes.json`: 17 archivos afectados y 13 evidencias coincidentes. Las bases de todos los archivos modificados coinciden con QA y la web activa. Los módulos del sandbox exclusivo, los gates generales y los archivos de pricing conservan los bytes de esa base. El cambio de `server.js` se limita a import/proyección/DTO de las dos rutas públicas de sedes.

La web parte del estado activo CRA/React19 de `/Users/Padbol-Match-Desarrollo/padbol-match-native/.web-commercial-live/padbol-match-frontend`. Se conservaron por hash el precio al jugador0%, el texto comercial, los objetivos vigentes y las traducciones20idiomas. **No copiar ni publicar esta carpeta backend entera como release comercial:** QA6b9 todavía contiene pricing histórico0.03; este delta no cambia precios y el coordinador integra el0% vigente por separado.

Se separaron los cambios necesarios de los otros cambios del follow-up `24022aa`: DTO público/administrativo, tres respuestas comerciales que devolvían filas, clientes de sedes y una migración únicamente de lectura. No se instala todo SQL14: esa migración también cambia XP y escritura, fuera de esta subtarea.

## Cambios concretos

- GET `/api/sedes` y `/api/sedes/:id`: el servidor consulta configuración para derivar los dos booleanos, después aplica whitelist pública. Conserva forma de array/objeto, precios, moneda, fotos y campos públicos. Los booleanos indican configuración almacenada; no certifican conexión ni un cobro exitoso en el proveedor.
- DTO administrativo y pendientes: suprime `stripe_account_id`, token MP, referencias privadas de facturación y nombres sensibles, incluso anidados; conserva licencia, horarios y workflow autorizado. El resolver de alcance existente no se amplía.
- POST de sede y creación mediante invitación: respuesta por el DTO, sin devolver fila privada.
- Web: estado de Stripe desde booleano; nunca necesita leer identificador privado. Fallback SedePublica por columnas explícitas. Mi Sede y estado de licencia por `/api/admin/sedes-alcance`, conservando JWT y sede del alcance. Errores descartan estado anterior; cancelación impide que una respuesta atrasada sobrescriba otra sede.
- Android13/fuente actual: no exige cambio de código para este contrato. Sus cuatro funciones de catálogo/detalle/perfil se ejecutaron sin cambios contra HTTP local y aceptan la respuesta protegida. Esto no es una prueba física de actualización de Android.
- SQL: revoca SELECT de tabla/columnas a PUBLIC, anon y authenticated, y concede sólo catálogo explícito. Mantiene exactamente políticas e INSERT/UPDATE/DELETE; no toca servicio, credenciales almacenadas ni XP. Un permiso privado heredado inesperado aborta la transacción en vez de declarar el cierre.

## Pruebas

- 53 pruebas backend de DTO/roles/alcance y45 pruebas del sandbox exclusivo.
- 6 contratos HTTP locales: rutas reales, autorización con identidad sintética y consumidores nativos extraídos sin cambios. Persistencia de estas rutas simulada; Auth/PostgREST reales pendientes.
- 59 pruebas web de pagos/consulta administrativa, precio0% y textos/idiomas vigentes.
- 3 pruebas adicionales ejecutan el efecto real de Mi Sede: error, cambio de sede/cancelación y parseo de módulos modificados.
- 36 comprobaciones en PostgreSQL local con la definición de `sedes` del snapshot de referencia: denegación de columnas privadas/SELECT *, catálogo permitido, servicio conserva configuración sintética, idempotencia y conservación de políticas/escritura. Filas sintéticas eliminadas al terminar. No son 36 escenarios de producción.

Los logs backend/sandbox/web/efecto/HTTP se reutilizan de la entrega congelada: sus hashes y los del código probado coinciden; no se presentan como ejecuciones nuevas. Se usó Node22.23.1. La prueba PostgreSQL sí se repitió en este lote:36 comprobaciones aprobadas sobre el mismo SQL exacto en una base sintética nueva. Los resultados y la procedencia están en `evidence/` y `delivery/manifest.json`. No se inició servidor completo con cron/proveedores ni se generó un nuevo bundle, APK o AAB.

## Secuencia compatible para el coordinador

1. Revisar `backend-minimal.patch` contra el código QA vigente con `git apply --check`, integrando sólo hunks. Conservar tarifas0%, documentos legales, sandbox WhatsApp exclusivo6b9, cierre de final, cuatro deportes y restantes parches. El diagnóstico Meta continúa fuera del alcance de este lote. `web-minimal.patch` parte de la copia activa congelada en `before/web`; no sobrescribir archivos completos.
2. Ejecutar `sql/preflight_sedes_public_read_columns.sql` en el destino: metadata solamente. Confirmar columnas, RLS, permisos efectivos y que el cliente **servidor** usado por estos endpoints tiene acceso. Confirmar también las dependencias de alcance y la visibilidad del catálogo. El snapshot de referencia tiene SELECT público USING(true); si el destino incorporó filtros por fila, el listado que ahora deriva indicadores con service_role deberá preservarlos antes de instalar. Este paquete no corrige las policies de escritura global de producción.
3. Instalar y probar primero API con DTO/booleanos. Publicar después la web compatible y verificar que los usuarios relevantes cargaron el bundle nuevo. Probar con cuentas sintéticas catálogo, Stripe configurado/no configurado/desconocido, Mi Sede propia/ajena, licencia/franjas, guardado autorizado sin lectura de credencial.
4. Versión propuesta local: `20260910235000_sedes_public_read_columns`, en `sql/migrations/20260910235000_sedes_public_read_columns.sql`; coincide byte por byte con `candidate_sedes_public_read_columns.sql` (SHA256 `eb21ae6f7b79ba4f71fb2c818764f37ddbf73f756b692b9f55820c5210595840`). Confirmar ausencia de esa versión en el historial del destino; si existe, revisar nombre/contenido y abortar ante discrepancia. Aplicar únicamente este archivo mediante el mecanismo del coordinador que registre la versión; no hacer push indiscriminado de migraciones. El archivo SQL no escribe `schema_migrations`: una ejecución manual aislada no acredita registro. Conservar el historial antiguo. `delivery/sql-minimal.patch` separa esta candidata de API/clientes; instalar ese patch en el repositorio no aplica permisos por sí solo.
5. Verificar anon/auth con `SELECT campo_privado FROM sedes LIMIT 0` y `SELECT * LIMIT 0` denegados, catálogo explícito operativo y rutas públicas/administrativas sin configuración privada. Probar los mismos clientes después de restringir permisos.
6. Comprobar app física publicada y caché/PWA de la web. Un navegador con JavaScript viejo puede seguir haciendo `select('*')` y fallará al cerrar permisos: debe actualizarse. No restaurar lectura privada para soportar una pestaña vieja. El cliente nuevo sobre backend viejo sin booleanos mantiene estado desconocido; no habilita Stripe por inferencia.

No se certifica aquí que todos los recorridos ajenos de RPC/RLS sean seguros. El cierre productivo requiere esa revisión de permisos efectivos y la instalación/verificación coordinada. Este paquete no amplía autoridad de jugadores ni administradores.

## Repetición local

Desde `backend`: `node --test lib/sedePublicPaymentStatus.test.js lib/adminCore.test.js lib/panelSedeSeguridadBloque1.test.js lib/adminTerritorialScope.test.js`.
Desde `web`: `CI=true node node_modules/react-scripts/bin/react-scripts.js test --watchAll=false --runInBand --runTestsByPath src/utils/miSedePagos.test.js src/utils/adminSedeConfig.test.js`.
Desde la raíz: `node --test tests/http-native-contract.mjs tests/web-effect-contract.mjs` (HTTP sólo127.0.0.1; necesita permiso local de escucha).
PostgreSQL: `python3 tests/sql-read-grants.py padbol_security_sedes_20260910_otra_prueba` (base nueva sintética; nunca reutiliza/elimina una base existente).
