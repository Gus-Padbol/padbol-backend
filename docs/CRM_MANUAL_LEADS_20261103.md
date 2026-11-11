# Alta manual de leads comerciales

Fecha: 2026-11-03.

## Modelo

Un lead manual es una conversación CRM real con `origin='manual'` y
`source_channel='email'`, más el caso existente `crm_commercial_form_cases`.
No crea eventos inbound, respuestas ni mensajes automáticos.

El origen se guarda como **Carga manual**. La procedencia conocida del contacto
(referido, evento, club, feria, etc.) se guarda en `qualification_data.manual.source_detail`,
separada de UTM, click IDs y campañas. No se inventan atribuciones publicitarias.

## Endpoints

- `GET /api/admin/crm/manual-leads/search?q=` — coincidencia por correo, teléfono
  normalizado o nombre. No fusiona ni modifica nada.
- `POST /api/admin/crm/manual-leads` — crea contacto si hace falta, conversación,
  caso comercial, primera gestión y programación.
- `GET /api/admin/crm/manual-leads/:id` — ficha editable.
- `PATCH /api/admin/crm/manual-leads/:id` — edita ficha y seguimiento; no toca
  leads históricos ni otras conversaciones.

## Permisos y datos

- Solo `manager`/`advisor` del área comercial.
- Un advisor solo puede asignarse a sí mismo; un manager puede elegir un asesor activo.
- Se reutilizan `crm_contacts`, `crm_conversations`, `crm_activities`,
  `crm_commercial_form_cases`, `crm_commercial_team_audit` y los endpoints de
  gestión/agenda ya existentes.
- El alta no envía mensajes al interesado. El correo/WhatsApp se usa solo como
  identidad de contacto; la respuesta sigue siendo una acción manual existente.
- La conversación manual es válida para el formulario comercial mediante
  `crm_commercial_form_is_allowed` (orígenes `manual`/`manual_contact`).

## Seguimiento

`CommercialLeadManagement` ya existente permite llamadas, reuniones, estado,
próximo paso, próxima charla, recordatorios, responsable e historial. El alta
manual crea la primera gestión con las notas iniciales y el próximo paso.

## Límites

- La vinculación de una conversación real posterior conserva el contacto por
  email/teléfono, pero el CRM sigue mostrando una conversación por canal. No se
  fusionan conversaciones automáticamente; no se eliminan registros.
- La edición no modifica la identidad de casos históricos no manuales.
