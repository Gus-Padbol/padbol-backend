# PADBOL PROSPECT — preparación para piloto

Fecha: 2026-11-04. `send_enabled=false`; no se enviaron correos reales.

## Implementado

- Secuencia de tres pasos (0/7/14) ES/EN con firma de Nicolás Renedo,
  remitente info@padbol.com, baja y enlace opcional a la experiencia.
- Clasificación de respuestas: interesado, información, precio/propuesta,
  reunión, no interesado, baja, ambigua y rebote.
- Detención de mensajes simulados/en cola ante respuesta, baja o rebote.
- Tarea/evento `advisor_task` asignado a Nicolás Renedo.
- Runner diario `runDueProspectMessages` con `dryRun` si `send_enabled=false`;
  valida estado, correo confirmado, respuesta/negociación, supresión y territorio.
- Tabla/API/UI de territorios protegidos; no se cargó ninguna exclusividad.
- Cuentas protegidas mediante `contact_block_reason`/supresiones existentes.
- Enlace a la experiencia mediante `PADBOL_EXPERIENCE_URL`.

## Pruebas

- Backend: 19/19 tests (`crmProspect*`, `crmInboundRoutes`).
- Frontend: 3/3 tests de PADBOL PROSPECT; build OK.
- Endpoints de producción responden 401 sin credenciales:
  `/api/admin/crm/prospect/run-due`, `/territories`, `/api/inbound/crm/prospect-reply`.
- `send_enabled=false` verificado.

## Bloqueos comerciales

1. **Textos aprobados**: no se encontró un documento con los textos comerciales
   aprobados por Gustavo. `PROSPECT_SEQUENCE_COPY_ES_EN.md` es la propuesta a
   aprobar; no se declara aprobada.
2. **Territorios y cuentas protegidas**: no se encontró información contractual
   utilizable en los repositorios. La tabla está vacía para no inventar
   exclusividades. Hay que cargar países/regiones/ciudades y cuentas protegidas.
3. **Activación**: el scheduler diario no está activo; el runner está listo para
   un cron. No se activó ningún envío ni campaña.

## Estado

Técnicamente preparado para un piloto, pendiente de:
- aprobar copy;
- cargar territorios/accounts protegidos;
- configurar `PADBOL_EXPERIENCE_URL` y el cron;
- autorización expresa para cambiar `send_enabled` a true.
