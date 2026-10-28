# Recuperación comercial de un correo institucional real

Esta operación permite clasificar un correo comercial que llegó directamente al buzón institucional. No convierte un correo en un formulario web ni abre la bandeja institucional al director o a los asesores.

## Frontera de acceso

- La evidencia autoritativa es una fila privada de `crm_commercial_email_triage`, creada por `crm_commercial_email_classify`. Los campos JSON de un correo o formulario no conceden acceso.
- El RPC solo es ejecutable por `service_role` y vuelve a comprobar `crm_commercial_owner(actor,true)`: el propietario exacto, con correo confirmado y rol persistido. El director y los asesores no pueden clasificar correos institucionales.
- El mensaje debe ser un `institutional_email` real ya registrado en `crm_conversations` y `crm_inbound_events`. Se rechazan conversaciones ocultas, vinculadas a otro hilo o de otros orígenes.
- La operación conserva `origin`, `source_ref`, `received_at`, asunto y cuerpo originales. Agrega metadata informativa de revisión, un registro privado inmutable y auditoría. No crea `form_submission`, no modifica consentimiento y no envía mensajes.
- Se crea un caso comercial usando la tabla histórica de casos de correo. La denominación interna `form` es compatibilidad de gestión; no cambia el origen del correo. Los listados y lecturas comerciales mantienen las funciones existentes de autorización: director y asesor asignado, nunca cualquier asesor.
- Repetir la operación es idempotente y no revierte una reasignación posterior. Para cambiar de asesor se utiliza la operación de asignación existente.

## Publicación y compatibilidad

Aplicar primero `20261028190000_crm_commercial_email_triage.sql`, después publicar el código y activar `CRM_COMMERCIAL_EMAIL_TRIAGE_ENABLED=true` una vez comprobados el esquema y los permisos. La bandera está apagada por defecto. Sin ella no se consulta la tabla nueva en la bandeja general. Si la migración o relación aún no existe, la fuente clasificada se omite de forma cerrada y las fuentes anteriores continúan funcionando.

La fuente adicional de la bandeja general usa un `inner join` con la tabla privada para obtener únicamente correos clasificados. No agrega `institutional_email` a la lista global de orígenes comerciales. La autorización JS usa un `Symbol` interno que no puede llegar en un JSON de formulario, ni reaparecer al copiar un objeto serializado.

Los DTO comerciales de lista y detalle agregan `sourceOrigin` y `sourceLabel` desde los metadatos reales de la conversación ya autorizada. Un correo institucional clasificado se presenta como **Correo electrónico**; `Formulario web` se reserva para un origen real `web_form:*`. El valor interno `channel='form'` mantiene la compatibilidad del flujo de gestión y no debe utilizarse como rótulo de procedencia. Si no se puede verificar la procedencia, el rótulo es **Consulta comercial**.

## Procedimiento privado de recuperación

1. Buscar el correo original en el buzón y comprobar su procedencia, cuerpo, fecha e identificador. No incluir datos reales de clientes en el repositorio, en ejemplos ni en pruebas.
2. Si todavía no está en CRM, recuperar el mensaje por el adaptador institucional canónico, con su identificador original y origen `institutional_email`. No usar un endpoint de formulario ni inferir consentimientos. Mantener el mismo identificador para evitar importaciones duplicadas.
3. Obtener el UUID persistido de esa conversación y el UUID del asesor activo que debe atenderla. La operación solo acepta esos identificadores, no el correo ni el nombre del cliente.
4. Ejecutar en el entorno privado autorizado, utilizando sus variables protegidas de base de datos:

   ```text
   node scripts/classify-commercial-email.mjs --actor UUID_DEL_PROPIETARIO --conversation UUID_DEL_CORREO --advisor UUID_DEL_ASESOR
   ```

   La operación anterior solo comprueba y muestra elegibilidad. No imprime mensaje, datos de contacto, claves ni identificadores del proveedor.
5. Después de verificar el diagnóstico y la bandera de activación, repetir con `--apply`. Puede añadirse `--reason` con una justificación administrativa sin datos personales. El servidor vuelve a validar el propietario y el origen en la misma operación que clasifica y asigna.
6. Consultar el caso desde el director y desde el asesor asignado. Comprobar que se ve el texto original, se conserva el origen correo y un asesor distinto no puede abrirlo. No reenviar mensajes al cliente para probar la recuperación.

RPC operativo:

```sql
select public.crm_commercial_email_classify($1, $2, $3, $4);
-- $1 propietario verificado; $2 conversación existente; $3 asesor activo;
-- $4 motivo administrativo (10–2000 caracteres).
```

Respuesta: `{conversationId, assignedUserId, alreadyClassified}`. La auditoría privada registra quién lo clasificó, cuándo, por qué, el origen y la referencia del mensaje. Ningún dato específico de una consulta real está incluido en este documento o en el código de pruebas.
