# Historial de correo del lead

Los mensajes recibidos que se guardan en `crm_inbound_events` ahora pueden consultarse con su texto original, junto con las respuestas salientes de `crm_replies`. No se modifica el formulario original en `crm_conversations.inbound_body`, ni se traduce, edita o elimina ningún mensaje.

- Bandeja general: `GET /api/admin/crm/inbox/:conversationId/email-history`.
- Espacio comercial: `GET /api/admin/crm/commercial-cases/:id/email-history?channel=form`.

Ambos devuelven `{truncated, messages}`. Cada mensaje contiene `id`, `direction` (`inbound` o `outbound`), `body` y `at`. Los entrantes incluyen `subject`; los salientes incluyen su `status` almacenado. `sent` expresa el estado registrado de envío; este endpoint no lo transforma en confirmación de entrega o lectura.

La respuesta contiene los últimos 200 entrantes y 200 salientes, ordenados cronológicamente. `truncated: true` indica que existe más historial. Incluye el evento original del formulario cuando ya esté registrado como evento entrante; la vista central puede conservar su presentación independiente. No inventa mensajes cuando no hay eventos, ni devuelve una lista vacía si falló la consulta.

El endpoint general reutiliza la identidad autenticada y el alcance de la bandeja actual. Nico solo puede consultar los correos comerciales permitidos; no puede utilizar el endpoint para consultar correos institucionales, soporte, contactos ocultos o WhatsApp. El propietario conserva su alcance de lectura existente.

El endpoint comercial verifica el rol persistido y la autorización de ese caso mediante `crm_commercial_team_form_read`. Un asesor solo obtiene los casos que puede atender. Se vuelve a comprobar ese permiso antes de devolver el resultado, para no entregar el historial si el caso fue reasignado u ocultado durante la consulta. No se duplica la definición SQL de esa autorización y no se requieren migraciones nuevas.

Las dos consultas filtran siempre el mismo `conversation_id`; los entrantes, además, `source_channel='email'`. No se relacionan conversaciones por nombre, dirección de correo ni un parámetro del cliente. No se devuelven direcciones del proveedor, identificadores RFC, tokens, operadores internos ni datos sin seleccionar. Los errores de consulta son genéricos y las respuestas llevan `no-store`.

Esto permite mostrar los correos que el adaptador de retorno realmente haya asociado y guardado. No activa por sí mismo la recepción IMAP, ni autoriza el buzón, ni recupera automáticamente los RFC Message-ID de envíos históricos.
