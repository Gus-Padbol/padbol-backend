# Ensayo aislado de WhatsApp en QA

Este modo permite responder al sandbox de WhatsApp mientras el interruptor general de operaciones externas permanece apagado. Sólo funciona en el servicio y proyecto QA configurados en `whatsappQaSandboxSend.js`; no habilita pagos, push, trabajos de fondo ni otros canales.

## Configuración

Después de comprobar la suscripción Meta con el diagnóstico privado, apagar `WHATSAPP_META_QA_STARTUP_CHECK_ENABLED`. Conservar las credenciales existentes en el servidor, sin copiarlas a logs o documentación.

Para el ensayo, establecer:

- `WHATSAPP_QA_SANDBOX_SEND_ENABLED=true`
- `WHATSAPP_CLOUD_SEND_ENABLED=true`
- `WHATSAPP_CLOUD_MAX_SEND_ATTEMPTS=1`
- `OUTBOUND_DELIVERY_ENABLED=false`
- `BACKGROUND_JOBS_ENABLED=false`
- `PUSH_SEND_ENABLED=false`

La configuración también exige la identidad exacta del servicio, proyecto, URL y Graph v26.0. Si se solicita este modo con una configuración incompatible, el arranque falla cerrado. Sin el flag específico, el comportamiento anterior se conserva.

## Alcance

El transporte queda encapsulado antes de instalar el bloqueo general de fetch. Sólo puede ejecutar un POST al endpoint de mensajes del teléfono sandbox fijado en el módulo, sin redirecciones. El servicio exige WABA, teléfono, canal, tenant, organización y referencia TEST exactos, con canal y tenant activos.

Cada respuesta fija se vincula a una entrada guardada y a una salida reclamada con un único intento. El servicio expone únicamente el manejo del webhook, cuya firma continúa verificándose en la ruta original. No expone envío libre ni barrido de pendientes. Los reenvíos del mismo evento conservan la idempotencia; una salida incierta no se reintenta automáticamente.

## Comprobación y cierre

`/ready` debe mostrar `whatsappQaSandboxSendEnabled=true` y los tres indicadores generales de envíos, tareas de fondo y push en false. Este indicador acredita la configuración del modo, no el estado del canal SQL ni la recepción de un mensaje real.

Activar exclusivamente el fixture TEST comprobado y coordinar una única entrada desde el destinatario autorizado. Comprobar una entrada, una salida, un intento y acuse de Meta. La entrega al teléfono requiere confirmación visible: el código no persiste estados de entrega o lectura.

Al terminar, pausar el canal y tenant TEST y establecer ambos flags específicos de envío en false. Conservar las filas para evidencia; no repetir un envío incierto.
