# WhatsApp manual: preparación para QA

Candidato basado en `b6a56d05`, con envío manual apagado por defecto. No habilitar flags de producción ni enviar mensajes durante estas comprobaciones.

- Validar el contrato con credenciales y datos exclusivamente sintéticos; el adaptador manual exige modo de producción y por eso no hay ensayo de red en QA sin una adaptación explícita y aislada. Los ensayos actuales usan proveedor simulado.
- Antes de cualquier activación, comprobar que la revisión de seguridad, canal y organización están autorizados, que el número y WABA identifican el canal activo correcto y que el operador está autorizado. Verificar por separado recepción y ventana de atención, sin cambiar el webhook existente.
- La migración de intentos debe revisarse y probarse en una base de QA antes de aplicarla en un destino confirmado. No instalarla por este documento.
- Los resultados inciertos quedan pendientes y bloquean otro envío de la misma conversación. Antes de operar hace falta un procedimiento autorizado para reconciliar el recibo y el historial sin provocar duplicados; no se proporciona una acción automática para liberarlos.
- Si se necesita detener la función, apagar los flags del adaptador y comprobar que deja de estar disponible. Conservar la tabla y los recibos de intentos: eliminar la tabla, los registros o la función mientras existen intentos inciertos destruiría la barrera contra duplicados. Revisar y coordinar cualquier cambio de esquema posterior.
- La infraestructura actual de producción debe verificarse separadamente: no deducir que un token, canal o webhook está configurado a partir de las pruebas locales.

## Ensayo aislado y límites

`node --test lib/crmWhatsappManualQaHarness.test.js lib/crmWhatsappManualSender.test.js` usa un proveedor en memoria, identificadores inventados y repositorio simulado. No se inicia el servicio ni se usa `fetch` de red. La prueba confirma acuse sintético, repetición idempotente y bloqueo tras incertidumbre; también confirma que staging no puede encender este adaptador. El modo de producción en la prueba es un objeto de configuración ficticio local, no una variable de entorno ni una conexión a producción. No equivale a una prueba de interfaz, del webhook, del esquema real o de Meta.

## Canal 0468: requisitos verificables antes de cualquier activación

Meta debe confirmar que el phone ID `1376102838911694` y el WABA `928900479733370` corresponden al 0468 y que el token autorizado tiene los permisos necesarios. En la base de destino debe existir una organización autorizada y un tenant activo de organización; el canal debe estar activo, vinculado a ese tenant, con ambos IDs exactos y una referencia de credencial válida. La configuración debe usar los UUID reales de canal y organización y una credencial almacenada de forma segura, sin copiarla a reportes. La migración de intentos debe existir en el destino confirmado; también debe verificarse por separado que el webhook del número y el CRM reciben eventos del canal correcto sin afectar QA. Se requiere operador autorizado y un mensaje entrante legítimo dentro de la ventana de atención. Revisar cualquier costo antes de cambiar facturación. No crear ni activar nada como parte de este preflight.

## Reconciliación de un intento incierto

1. Mantener el intento pendiente y no volver a enviar, incluso con otra referencia. Restringir acceso al historial por sus datos de contacto.
2. Registrar para auditoría la referencia interna, conversación, hora aproximada, canal y operador, sin divulgar credenciales. Consultar en modo lectura el historial del CRM y los comprobantes o estados disponibles del proveedor para ese mismo intento.
3. Si hay evidencia inequívoca de aceptación y un identificador de mensaje verificable, conservarla y escalar a la persona autorizada. La confirmación de entrega y la aceptación son estados diferentes. Si no hay evidencia concluyente, mantener el bloqueo; la ausencia de un recibo no demuestra que no se envió.
4. Actualmente no hay herramienta de reconciliación autorizada, ni una operación que actualice el intento con controles de concurrencia y registro de auditoría. No editar la base manualmente ni liberar el bloqueo con este documento. Diseñar y probar esa operación por separado antes de permitir resolución; solo después de reconciliar puede decidirse si corresponde un nuevo envío autorizado.
