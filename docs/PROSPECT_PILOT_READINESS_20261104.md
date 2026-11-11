# PADBOL PROSPECT — preparación para piloto

Fecha: 2026-11-04. `send_enabled=false`; no se enviaron correos reales.

## Implementado

- Secuencia definitiva de tres pasos (0/7/14) ES/EN aprobada por Gustavo,
  con firma de Nicolás Renedo, remitente info@padbol.com y baja funcional.
- Personalización de saludo y club; idioma por preferencia o país.
- `{{experienceUrl}}` solo se sustituye por un enlace HTTPS oficial de
  padbol.com; si falta, el runner bloquea el envío y la vista previa conserva
  el marcador para revisión.
- Clasificación de respuestas: interesado, información, precio/propuesta,
  reunión, no interesado, baja, ambigua y rebote.
- Detención de mensajes simulados/en cola ante respuesta, baja, rechazo,
  reunión o rebote.
- Tarea/evento `advisor_task` asignado a Nicolás Renedo.
- Baja funcional firmada: `/api/prospect/unsubscribe`.
- Runner diario `runDueProspectMessages` con dry-run si `send_enabled=false`;
  valida estado, correo confirmado, respuesta/negociación, supresión,
  territorio, enlace oficial y baja configurada.
- Tabla/API/UI de territorios protegidos; no se cargó ninguna exclusividad.
- Cuentas protegidas mediante `contact_block_reason`/supresiones existentes.

## Pruebas

- Backend: 22/22 tests (`crmProspect*`, `crmInboundRoutes`).
- Seis asuntos y tres pasos ES/EN verificados.
- Baja firmada y rechazo de enlace localhost verificados.
- Endpoints de producción: `/api/admin/crm/prospect/run-due`,
  `/territories`, `/api/inbound/crm/prospect-reply` y
  `/api/prospect/unsubscribe` (401/400 según corresponda).
- `send_enabled=false`; no hay cron activo.

## Pendiente para activar el piloto

1. Publicar la presentación interactiva y configurar `PADBOL_EXPERIENCE_URL`
   con la URL HTTPS oficial.
2. Cargar territorios y cuentas protegidas reales.
3. Definir el remitente legal completo exigido por cada mercado (razón social
   y dirección si corresponde).
4. Aprobación expresa para cambiar `send_enabled` y activar el cron.

## Vista previa

- `PROSPECT_SEQUENCE_FINAL_PREVIEW.html` (seis correos con personalización de muestra).
- `PROSPECT_SEQUENCE_COPY_ES_EN.md` (texto aprobado con marcadores de implementación).
