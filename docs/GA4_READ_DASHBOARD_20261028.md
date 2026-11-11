# Lectura de Google Analytics en Contenido y campañas

## Alcance implementado

`GET /api/admin/content/workspace/analytics/status` describe la configuración; no realiza conexiones con Google. `configured` significa que existe una credencial con formato válido, no que Google haya autorizado la propiedad ni que existan datos.

`GET /api/admin/content/workspace/analytics/summary?since=2026-10-01&until=2026-10-27` consulta directamente Google Analytics Data API. Sin fechas utiliza los últimos 28 días completos. Admite como máximo 92 días inclusivos y comprueba la zona horaria que informa Google para no mostrar como completo el día actual.

Solo dirección y coordinación autorizada de Contenido y campañas tienen acceso. Además de la sesión autenticada y su capacidad de coordinación, cada llamada vuelve a comprobar `public.content_meta_access(actor)` en la base. El editor de contenido no recibe acceso a los informes. Las respuestas llevan `Cache-Control: private, no-store`.

Los identificadores son los existentes, confirmados en el correo de Juan Pablo: propiedad **435359413**, flujo web **7814357529**, etiqueta **G-YSJQXF18JV**. El cliente no puede elegir otra propiedad, flujo, dimensión ni métrica. Las solicitudes solo contienen fechas, la dimensión diaria y cuatro métricas agregadas. No se consultan usuarios identificados, correos, URLs con parámetros, teléfonos ni datos individuales del CRM.

Las tarjetas representan usuarios activos únicos del período, sesiones, vistas y eventos `lead_success`. Este último indicador es medición de consultas confirmadas de la web; no acredita ventas ni sustituye el historial del CRM. Los usuarios del período se solicitan a Google: no se suman los usuarios diarios. Las métricas ausentes se devuelven como `null`, nunca se inventa un cero. El panel conserva advertencias cuando Google informa muestreo, límites de privacidad o agregación.

## Autorización externa necesaria

La etiqueta pública instalada en la web envía eventos, pero no concede lectura de los informes. Tampoco basta el permiso humano Lector para `padbolinternacional@gmail.com`: permite abrir Analytics en el navegador, pero no habilita el servicio automático.

Para activar este adaptador, una persona autorizada debe:

1. Seleccionar un proyecto de Google Cloud controlado por la empresa. No crear un proyecto nuevo ni aceptar condiciones o cargos por defecto.
2. Habilitar **Google Analytics Data API** en ese proyecto, si aún no está habilitada.
3. Utilizar una cuenta de servicio dedicada a lectura de Analytics. No asignarle roles amplios en Google Cloud. La creación de identidad o clave y los nuevos permisos requieren la aprobación correspondiente del propietario.
4. En Analytics, propiedad **435359413**, Administración → Gestión de accesos a la propiedad, incorporar la dirección de esa cuenta de servicio como **Lector**. No conceder administración ni acceso a otras propiedades.
5. Guardar exclusivamente en los secretos del backend:
   - `GA4_READ_SERVICE_ACCOUNT_EMAIL`: dirección de esa cuenta de servicio.
   - `GA4_READ_SERVICE_ACCOUNT_PRIVATE_KEY`: clave privada PEM de esa misma identidad. Se admiten saltos de línea reales o escapados `\n`.
   - `GA4_READ_TIMEZONE`: opcional, zona IANA real de la propiedad. El valor por defecto solo calcula las fechas iniciales; la respuesta utiliza y valida la zona que devuelve Google.
6. No enviar la clave por correo, WhatsApp, chat, repositorio, capturas ni campos del frontend. No reutilizar credenciales personales o de otras aplicaciones.
7. Publicar/reiniciar el servicio mediante el proceso normal. Consultar primero `/status` con una sesión de dirección o coordinación; luego `/summary` para un período completo. Solo una respuesta válida de informes demuestra que el acceso funciona.

No se ejecutó ninguno de estos cambios externos desde esta implementación. Sin credencial, el endpoint de resumen responde `409 GA4_READ_CONNECTION_NOT_CONFIGURED`, con un mensaje claro. Google 401/403 se muestra como autorización de lectura fallida; los errores del proveedor, la clave y los tokens no se incorporan a las respuestas ni a registros de esta integración.

## Transporte y verificación

La autenticación firma JWT RS256 con clave RSA de al menos 2048 bits, audiencia fija `https://oauth2.googleapis.com/token` y alcance único `https://www.googleapis.com/auth/analytics.readonly`. El token permanece en memoria hasta su vencimiento y cada nueva consulta revalida primero el permiso interno del solicitante.

Los únicos destinos son los endpoints oficiales de OAuth y Data API; se rechazan redirecciones. Los cuatro informes se solicitan en un lote: totales y días del uso general, totales y días de `lead_success`, todos limitados al flujo existente. No hay llamadas de modificación de Analytics, campañas ni permisos.

Documentación primaria utilizada:

- [Google Analytics batchRunReports](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/batchRunReports)
- [Dimensiones y métricas de Data API](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
- [Metadatos, muestreo y zona horaria](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData)

Las pruebas automatizadas utilizan una clave RSA generada en memoria y respuestas simuladas, sin credenciales ni estadísticas de producción. Validan la firma y el alcance, el bloqueo de editores y accesos revocados, los identificadores fijos, límites de fechas, totales sin sumar usuarios diarios, ausencias sin ceros falsos y errores sin secretos.
