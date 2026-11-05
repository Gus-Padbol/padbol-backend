# Revisión de seguimiento comercial — 2026-11-05

## Alcance y aislamiento

- Base: `ae5399d5` (`origin/main` al inicio de la revisión).
- Rama: `fix/prospect-followup-guard-20261105`.
- Commit: `c74ca6916af1083de51b98474ec6835d652995fd`.
- Diff: 14 archivos, únicamente PROSPECT.
- No se modificaron `crmSpace*`, `crmSpaceReviewVersion.js`, `crmInboundRoutes.js` ni sus tests.
- No se conectó worker, scheduler, base real, proveedor real ni se envió nada.

## Revisión de regresiones

Comandos:

```bash
git diff --check ae5399d..HEAD
git diff --stat ae5399d..HEAD
git diff ae5399d..HEAD -- lib/crmProspectRunner.js lib/crmProspectApi.js lib/crmProspectReply.js lib/crmProspectCampaigns.js
```

Resultado: sin errores de whitespace; el diff se limita a 14 archivos de PROSPECT.

Hallazgos:

1. El runner ahora aplica el guard central antes de preparar un mensaje vencido; sigue sin enviar mientras `send_enabled=false`.
2. El guard falla cerrado si no puede leer campaña, supresiones, conversación, respuestas o negociación.
3. `dispatchProspectMessage` reclama de forma atómica y vuelve a aplicar el guard justo antes de llamar al proveedor; no está montado en ninguna ruta/worker.
4. La derivación ya no escribe `assigned_to: 'Nicolás Renedo'`; conserva `assigned_user_id` y marca `requires_assignment` cuando falta.
5. Se añadieron etapas 1 y 3 al copy/planificación; requieren aprobación expresa.
6. No se encontró una ruta de envío real ni un scheduler dentro de este diff.

Riesgo residual: los nombres de constraints SQL se asumen por la convención de PostgreSQL; deben validarse contra el esquema real en staging antes de aplicar.

## Pruebas locales

```bash
node --test lib/crmProspect*.test.js
# 23/23 pass
```

E2E local equivalente: `lib/crmProspectDispatch.test.js` usa una base en memoria y un proveedor simulado; cubre mensaje cargado → claim → guard → `send` mock → estado final.

```bash
node --test lib/crmProspectDispatch.test.js
# 3/3 pass
```

Casos cubiertos por la suite:

- simulación/deshabilitado no llama al proveedor;
- dos claims concurrentes producen un solo envío;
- fallo/timeout del proveedor deja `uncertain` y no reintenta solo;
- conversación manual, respuesta pendiente, negociación, supresión, rebote y otra secuencia bloquean;
- cinco etapas 0/1/3/7/14.

## SQL revisado, NO aplicado

- `sql/20261105193000_crm_prospect_sequence_days.sql`
  - amplía los `CHECK` de días a `0,1,3,7,14`.
- `sql/20261105194000_crm_prospect_dispatch_status.sql`
  - permite `sending` y `uncertain` en `crm_prospect_messages.status`.
- No se ejecutó en staging ni producción; no se crearon permisos ni credenciales.

## Copy de etapas 1 y 3

Borrador separado en `docs/PROSPECT_SEQUENCE_STAGE_1_3_DRAFT.md`. **No aprobado, no enviado.**

## Pendientes mínimos para integración

1. Revisar/aprobar el copy de etapas 1 y 3.
2. Validar los nombres de constraints y aplicar migraciones en staging.
3. Revisar el diff con el dueño de integración.
4. Conectar `dispatchProspectMessage` a un worker aprobado, manteniendo `send_enabled=false`.
5. Prueba end-to-end staging con proveedor simulado.
6. Sólo después evaluar habilitación de envío real.

## Evidencia y límites

- `send_enabled` permanece false.
- No se hicieron envíos, no se activaron campañas.
- No se probó pestaña/navegador ni dispositivo real: el alcance es backend/pruebas.
