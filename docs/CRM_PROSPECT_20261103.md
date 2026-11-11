# PADBOL PROSPECT — arquitectura, operación y costos

Fecha: 2026-11-03. Módulo dentro del CRM existente. No es un CRM paralelo.

## Arquitectura

- Frontend: pestaña **PADBOL PROSPECT** dentro de `/crm-leads` (`CommercialProspects.jsx`), con filtros, tabla/lista, ficha, panel ejecutivo y campañas simuladas.
- Backend: rutas `/api/admin/crm/prospect/*` (`lib/crmProspectRoutes.js`), autenticadas y limitadas a manager/advisor del equipo comercial (RPC `crm_commercial_team_role`).
- Datos: tablas `crm_prospect_*` en el mismo Supabase. Se enlazan a `crm_contacts`, `crm_conversations` y casos existentes cuando hay coincidencia; no crean conversaciones ni envíos al investigar.
- Fuente pública habilitada: OpenStreetMap vía Nominatim/Overpass, con atribución ODbL y límite de 50 resultados por corrida. No hay scraping ni evasión de restricciones.
- Google Places: no se activó. Requiere API key, presupuesto y aprobación expresa; el adaptador no realiza llamadas sin esa configuración.
- Correo: no se envía nada en esta fase. La simulación crea mensajes con estado `simulated`; el envío real requiere habilitar `send_enabled`, aprobación de campaña y el transporte existente (Resend). El gate actual es fail-closed.

## Feature flags y operación

- `crm_prospect_settings.enabled` (default `true`): muestra/oculta y habilita la API con 404 si se apaga.
- `crm_prospect_settings.send_enabled` (default `false`): bloquea envío real.
- `crm_prospect_settings.daily_limit` y `weights`: configurables por SQL.
- No se agregó cron nuevo. Las búsquedas se ejecutan a demanda desde la API; una búsqueda periódica requiere un job autorizado y presupuesto.
- Para desactivar: `update public.crm_prospect_settings set enabled=false where singleton`.
- Rollback de esquema: `sql/20261103230000_crm_prospect.rollback.sql`.

## Datos y cumplimiento

- Se guarda fuente, URL, fecha de verificación y estado de cada dato (`confirmed`/`inferred`/`missing`).
- Se excluyen clubes exclusivamente de pádel de la prospección activa.
- Supresiones globales en `crm_prospect_suppressions`; una respuesta de baja/rebote agrega la identidad.
- No se usan aperturas de correo como interés. El panel separa métricas reales de estimaciones.
- La puntuación 0-100 es explicable y no es intención de compra confirmada.
- La vinculación a CRM conserva contacto, conversación, caso e historial existentes; no sobrescribe estado/responsable comercial.

## Costos

- OpenStreetMap/Nominatim/Overpass: costo de licencia USD 0; cumplir atribución ODbL, User-Agent y política de uso (máx. 1 req/s; ya se espacian consultas).
- Google Places: no habilitado, costo variable por SKU; no se ejecutó ninguna llamada.
- Correo: no habilitado; si se habilita, usa el proveedor existente y sus costos actuales. No se creó cuenta nueva.
- Infraestructura: tablas pequeñas en Supabase y endpoints en el backend Render existente; no se creó servicio pagó.

## Límites actuales

- La búsqueda pública devuelve empresas con datos OSM; muchas no tienen email verificado, por lo que no son contactables automáticamente. No se inventan correos.
- La campaña piloto se ejecuta en simulación. El envío real no está habilitado.
- La detección automática de respuestas reales requiere conectar el hilo de correo existente a la cola de prospectos; esta entrega incluye clasificación manual/simulada y suspensión de secuencia.
- La asignación territorial se apoya en responsables existentes; no hay tabla de territorios comerciales dedicada.
