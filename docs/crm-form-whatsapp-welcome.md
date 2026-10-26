# Formulario CRM → bienvenida WhatsApp

La cola es el CRM persistido. Sólo consulta comercial visible, consentimiento exacto ES/EN y fecha posterior a activación explícita. No se crea una segunda consulta ni se usa el cuerpo del browser como cola. Una reserva permanente por conversación precede el envío; timeout/crash incierto nunca se repite automáticamente. El acuse aceptado queda en historial CRM.

Al responder, el webhook firmado ya persistido permite una asociación única por teléfono consentido+acuse realmente aceptado; no se fusionan contactos ni cambian permisos. Coincidencias ambiguas no se enlazan. No se reemplaza tema elegido ni atención humana. Enlace verificado permite preguntas directas a Chivi; precios/condiciones siguen derivándose. Revocación/STOP cancela ese enlace. No se envía formulario ni teléfono al proveedorIA.

## Activación separada de los seis seguimientos
1. Aplicar revisada `sql/migrations/20261026190000_crm_welcome_dispatch.sql`.
2. Ejecutar en Render `node scripts/inspect-crm-welcome-readiness.mjs` (sólo lectura). No imprime secreto, teléfonos/personas ni cuerpos de plantilla.
3. Si no existen dos plantillas iniciales APPROVED con los cuerpos exactos en `lib/crmWelcomeConfig.js`, presentarlas en Meta como paso externo; no habilitar con nombres de las seis plantillas de seguimiento. Revisar categoría que Meta determine; no prometer aprobación.
4. Configurar IDs exactos existentes: phone1376102838911694/WABA928900479733370; nombres+localesES/EN verificados. Reutiliza `CRM_WHATSAPP_ACCESS_TOKEN` y `WHATSAPP_META_GRAPH_VERSION` existentes, sin copiar secreto al cliente.
5. Tras revisar webhook/link, `CRM_WELCOME_INBOUND_READY=true`. Fijar `CRM_WELCOME_ACTIVATED_AT` al instante real de activación para excluir históricos. Sólo entonces `CRM_FORM_WHATSAPP_WELCOME_ENABLED=true`; exigeproduction/outbound/Chiviactivo. DefaultsOFF.
6. Verificar status Meta/CRM y una prueba humana autorizada; sin inventar lead ni enviar mensajes reales desde tests.

La falta de aprobación inicial es un bloqueo externo, no una razón para activar sin aprobación. Código OFF publicado no equivale a bienvenida operativa. El chequeo de plantillas usa sóloGET y el envío es single-attempt; no se cambian campañas/permisos.
