# Recepción anterior al identificador de Resend

Esta extensión requiere `crmEmailReturn.js` y la migración de recibos `20261028160000`. No modifica envíos, cuentas, permisos de personas ni el contenido original del CRM.

## Integración mínima

1. Aplicar `20261028170000_crm_email_return_queue.sql` después de la migración de recibos.
2. En servidor, envolver el servicio existente y pasar el objeto envuelto tanto al webhook como al lector IMAP:

```js
import {createCrmEmailReturnQueue} from './lib/crmEmailReturnQueue.js';
const crmEmailReturn = createCrmEmailReturnQueue({
  pool: pgPool,
  emailReturn: createCrmEmailReturn({pool:pgPool}),
});
```

Los hooks de los puntos 3 y 4 ya están incluidos en el commit:

3. En `createCrmImapInboxSync.syncOnce()`, dentro del bloque protegido por `running` y antes de seleccionar nuevos UIDs, ejecutar `await emailReturn?.reconcilePending?.()`. Debe ejecutarse incluso si no hay mensajes nuevos: así se recupera la cola tras reiniciar.
4. Después de `await crmService.ingestInbound(...)` y antes de incrementar el UID procesado: `await emailReturn?.afterFallback?.(event)`. Si falla, no avanzar el UID. El reintento es idempotente.
5. La proyección de la bandeja debe excluir registros con `email_return_linked_to` y las operaciones deben rechazar cambios sobre una copia ya vinculada. Es compatible filtrar en la proyección de la API antes de activar la cola: una columna todavía ausente se considera sin vínculo. No añadir una condición SQL sobre una columna inexistente antes de aplicar la migración. Conservar el acceso directo auditado al original por ID. No utilizar `test_hidden_at`: son correos reales, no pruebas.
6. Activar `CRM_EMAIL_RETURN_QUEUE_ENABLED=true` solo junto con la recepción de correo y el webhook autenticado ya configurados. Por defecto está apagada y delega al comportamiento previo sin tocar la cola.

El origen de fallback admitido es únicamente `institutional_email`, con el `source_ref` RFC original que usa IMAP. Si se configura otro origen, no activar el enlace automático sin adaptar y revisar esta regla. El pool debe permitir al menos dos conexiones: el bloqueo de reconciliación conserva una sesión y el servicio de retorno utiliza su propia transacción.

## Comportamiento

El mensaje con referencias RFC se guarda primero en una cola PostgreSQL privada. Solo se considera resuelto cuando el servicio existente confirma una coincidencia única entre referencia autenticada del proveedor e identidad del contacto. No se une por asunto ni por dirección de correo solamente.

Si falta el recibo de Resend, IMAP conserva el correo en la bandeja institucional del superadmin. Cuando llega el webhook autenticado, o en la siguiente revisión del lector, se inserta de manera idempotente en el historial del lead original. La copia institucional se vincula con `email_return_linked_to` y sale de las consultas de bandeja, conservando cuerpo, evento, estado e identidad originales. Se registra una nota en el lead y un vínculo auditado inmutable. No se eliminan registros.

El enlace se realiza solo para una copia institucional todavía nueva, sin asesor asignado, derivación, respuesta ni gestión humana. Si alguien ya la atendió, permanece visible y queda `needs_review/FALLBACK_HAS_HUMAN_WORK`. Las referencias ambiguas, identidad distinta, múltiples fallbacks y conflictos de un mismo Message-ID nunca producen un enlace automático. Las variantes conflictivas se conservan en auditoría; no reemplazan el original.

Una caída después de guardar en cola, después de crear el fallback o después de insertar la respuesta en el lead se recupera desde PostgreSQL. El escaneo busca también duplicados institucionales creados antes de que se ejecutara `afterFallback`. Un fallo durante el vínculo revierte ese vínculo y su auditoría; la respuesta ya persistida se reutiliza sin duplicación.

Los claims de respuesta y las notas humanas toman un bloqueo compatible con la clave de la conversación: si el vínculo ya ganó la carrera, se rechazan antes de enviar; si el claim ya existe, no se oculta el fallback. La API también debe rechazar futuras modificaciones comerciales de una copia ya vinculada, manteniendo su lectura auditada por ID.

La función interna `crm_email_return_link_fallback` exige evidencia de recibo, identidad, evento recibido y estado de cola; no es ejecutable por `anon` o `authenticated`. La columna no está disponible en operaciones públicas de asesores. El trigger impide asignarla directamente sin evidencia de vinculación y prohíbe insertarla preestablecida. No añadir campos de entrada públicos para modificar esta columna.

## Lectura del texto conservado

`crm_email_return_pending.raw_event.body` conserva la vista canónica de hasta 4.000 caracteres. `raw_event.originalBody` conserva el texto que recibe la extensión, hasta 5 MB, si el lector ya lo proporciona. El lector IMAP actual recorta su texto antes de llamar al servicio: esta extensión **no recupera retroactivamente** el texto descartado, archivos adjuntos ni MIME original. No se afirma que exista un histórico completo que aún no fue importado.

Para exponer el texto ampliado en el historial, comprobar primero el permiso sobre el lead y después consultar exclusivamente `where linked_conversation_id=$lead_autorizado`. No listar la cola global, remitentes o mensajes de otras consultas para un asesor. Este commit no añade una vista global de pendientes. La revisión excepcional de la cola se realiza desde herramientas administrativas autorizadas; cualquier futura vista global deberá comprobar la autorización real del superadmin.

No se envía ningún correo o WhatsApp durante la reconciliación.
