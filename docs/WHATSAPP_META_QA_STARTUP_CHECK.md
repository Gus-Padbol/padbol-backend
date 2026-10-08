# Comprobación privada de Meta en QA al arranque

Candidato basado exclusivamente en `0417776069846db9df7e51b96d8357d48eb81802`. No aplicado ni desplegado como parte de su preparación. No añade ninguna ruta HTTP ni modifica SQL, suscripciones Meta, contenido del bot o activación del canal.

## Por qué hace falta este cambio

El release existente no expone un diagnóstico Meta autenticado y el servicio Render Free no dispone de Shell/OneOff según la comprobación del coordinador. `/ready` no valida claves Meta. La prueba negativa ya devuelve 401, lo que acredita presencia del App Secret en el proceso, pero no su corrección. El único diagnóstico propuesto usa las variables que ya están dentro del propio servidor.

El guard global de staging bloquea también las lecturas de Graph cuando la entrega está desactivada. Este cambio conserva ese guard sin modificaciones. Antes de instalarlo captura el transporte en un cierre privado que sólo permite dos rutas GET exactas del sandbox. Ese transporte no se devuelve, no se monta en HTTP y no está disponible para los demás servicios. Es una autorización de lectura diagnóstica independiente, no una habilitación de entregas.

## Condiciones para ejecutarse

Variable nueva, sin valor por defecto: `WHATSAPP_META_QA_STARTUP_CHECK_ENABLED=true`. Si no tiene exactamente ese valor, no realiza consultas ni emite una línea diagnóstica.

Cuando está activada exige simultáneamente:

- `BACKEND_RUNTIME_MODE=staging`.
- `STAGING_SUPABASE_PROJECT_REF=vxikhdulhuvghfqeutnp` y su URL Supabase exacta.
- `RENDER_SERVICE_ID=srv-dahbs0dbedkc73a0kf4g` y `RENDER_EXTERNAL_URL=https://padbol-backend-qa.onrender.com`.
- `OUTBOUND_DELIVERY_ENABLED=false`, `WHATSAPP_CLOUD_SEND_ENABLED=false`, `BACKGROUND_JOBS_ENABLED=false`, `PUSH_SEND_ENABLED=false`.
- App Secret, token TEST y verify token presentes; `WHATSAPP_META_GRAPH_VERSION=v26.0`.
- `WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS=1` o ausente, cuyo valor por defecto ya es 1.

No hacen falta claves nuevas. Nunca mostrar, copiar a la Mac ni introducir las claves en argumentos, URLs o mensajes.

## Ejecución y alcance exacto

El servidor inicia la comprobación después de abrir su puerto HTTP, sin esperar al resultado para atender `/health`. Una única ejecución por proceso; no hay cron ni reintentos automáticos. Si el proceso se reinicia mientras el flag sigue activo, se repiten sólo las lecturas; desactivar el flag una vez registrado el resultado.

Reutiliza sin modificaciones `verify-meta-sandbox-v26.mjs`, SHA-256 `afcf28994e4adf4a1eb1ec0e64e1ab5039f466b23e388c7d2afc2f9db1e30e90`:

1. GET de `v26.0/1384040043841797/subscribed_apps`, con paginación acotada, para buscar la app `2178656636869198`.
2. GET de `v26.0/1300908966439481`, campos `id,display_phone_number`, para confirmar el sandbox esperado.

Sólo `graph.facebook.com` HTTPS, sin redirecciones, body ni tokens en query. El token TEST va únicamente en Authorization. No consulta `/messages`, el teléfono oficial ni recursos de otros canales. No ejecuta POST/DELETE ni corrige suscripciones automáticamente. Las URLs `paging.next` se ignoran; sólo se toma un cursor hacia el mismo host y ruta. Máximo 11 lecturas y 25 segundos totales, abortando lo pendiente. No detiene el servidor ante un fallo.

Los logs contienen una línea con prefijo fijo `[whatsapp-meta-qa-check]` y JSON construido por lista permitida. Sólo valores booleanos, nulos, códigos fijos y códigos numéricos acotados. No se imprimen IDs, números de teléfono, URLs, cabeceras, entornos, cuerpos de respuesta, nombres de apps ni mensajes de error de Meta.

## Procedimiento de integración propuesto para el coordinador

1. Revisar el parche aislado y aplicarlo sobre la rama QA basada en el SHA indicado. No incorporar otros pendientes de frontend, incentivos o producción.
2. Mantener los cuatro controles de envío apagados y el canal TEST inactivo. Activar únicamente el nuevo flag diagnóstico en el servicio QA. Conservar las claves que ya cargó Gustavo.
3. Desplegar el commit revisado a ese servicio y confirmar Live. En Logs, buscar el prefijo fijo. Esta preparación no ejecutó estos pasos.
4. Resultado esperado: `code=META_QA_PREFLIGHT_PASSED`, `wabaAppSubscribed=true`, `sandboxPhoneMatches=true`, `metaPreflightPassed=true`.
5. Guardar sólo esa línea saneada como evidencia del despliegue. Desactivar el flag tras capturarla; no se necesita mantener el diagnóstico en reinicios posteriores.
6. La activación controlada del canal y de ambos flags de envío sigue siendo un paso posterior coordinado, para el único mensaje real autorizado. Este diagnóstico nunca realiza esa activación ni genera el mensaje.

## Cómo interpretar los resultados

- `META_QA_SCOPE_REQUIRED`: identidad o aislamiento de QA no coincide. No se consultó Meta.
- `META_QA_DELIVERY_MUST_BE_DISABLED`: al menos un control no está explícitamente apagado. No se consultó Meta.
- `META_QA_CONFIGURATION_INCOMPLETE`: falta una variable requerida, la versión no coincide o hay más de un intento configurado. Revisar sólo nombres/configuración, sin revelar valores privados.
- `META_READ_REJECTED`: Meta rechazó una lectura. `providerCode`, `providerSubcode` y `httpStatus` son los únicos detalles. Un error de permisos no prueba que falte la suscripción; `wabaAppSubscribed=null` significa desconocido. Juanpi podrá confirmar con su acceso si el token TEST carece de ese permiso.
- `META_QA_PREFLIGHT_INCOMPLETE` con `wabaAppSubscribed=false`: la lista completa consultada no contiene la app esperada. No se suscribe automáticamente.
- `sandboxPhoneMatches=false`: el recurso leído no coincide con el número de prueba esperado. No habilitar envío.
- `META_PAGINATION_LIMIT`, `META_PAGINATION_UNVERIFIED`, timeout o indisponibilidad: comprobación incompleta; no interpretar como ausencia ni como éxito.

Un resultado positivo acredita que el token del runtime permitió estas lecturas, la app aparece suscrita a la WABA y el Phone ID coincide con el sandbox. No demuestra por sí solo permisos de envío, pertenencia del token a esa app, que el campo `messages` siga activo, que App Secret sea correcto, que el canal SQL esté activo o que haya respuesta visible en el teléfono. Por eso los campos `appSecretVerified`, `messageDeliveryVerified` y `activationPerformed` siguen en false. La firma entrante auténtica y el circuito real pendiente acreditarán esos pasos.

## Validación local

35 pruebas focales pasan con Node 22.23.1 (mismo major declarado por QA): 14 de WhatsApp existente, 7 del verificador reutilizado y 14 de la nueva integración. Cubren aislamiento, flags, limitación GET, producción excluida, paginación maliciosa, redirecciones, códigos de permisos, ausencia de claves en logs, timeout, ejecución única y coexistencia con el guard global. Todas las solicitudes de las pruebas son mocks; no se contactó Meta.

## Fuentes primarias consultadas

- Render documenta `RENDER_SERVICE_ID` y `RENDER_EXTERNAL_URL` como variables automáticas: https://render.com/docs/environment-variables
- La colección oficial de Meta documenta GET para listar apps suscritas a una WABA y el campo `whatsapp_business_api_data.id`: https://www.postman.com/meta/whatsapp-business-platform/request/tl2wk2j/get-all-subscriptions-for-a-waba
- Se conserva el contrato de Graph v26.0 preparado y probado previamente para este sandbox; esta subtarea no verificó endpoints autenticados reales.
