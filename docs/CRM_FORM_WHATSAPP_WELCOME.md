# Formulario → bienvenida WhatsApp

La consulta se confirma primero en CRM. El proceso revisa cada minuto únicamente formularios comerciales nuevos posteriores al instante de activación, recibidos hace menos de treinta minutos, con consentimiento explícito versionado, idioma ES/EN y teléfono internacional coincidente. Nunca recupera formularios antiguos para enviarles mensajes.

Usa exclusivamente `padbol_contacto_chivi_es_v1` y `padbol_contacto_chivi_en_v1`, comprobando en Meta aprobación, cuenta, idioma y texto exactos. El acceso corresponde al canal oficial ya configurado. La migración crea una bandeja privada vacía: no envía nada.

Antes de enviar registra una reserva durable única por número y por evento. Una aceptación ambigua, caída o interrupción requiere revisión; no hay reenvíos automáticos. Una llamada, atención humana, respuesta, cierre, identidad dudosa o BAJA excluye el envío. La aceptación del proveedor queda en el historial como nota; no se presenta como lectura o entrega confirmada.

Cuando ese número responde, una bienvenida realmente aceptada permite reconocer el contexto durante catorce días, conservando el mensaje original. Las preguntas explícitas y el comando Chivi usan el asistente informativo existente, con sus restricciones comerciales. Los horarios quedan registrados para el asesor sin gastar una llamada a la IA. Se conserva el acceso humano y no se atribuye al asesor una conversación que no realizó.

Activación: aplicar `20261028210000_crm_form_whatsapp_welcome.sql`, publicar código, verificar `inspect()` y configurar `CRM_FORM_WELCOME_ENABLED_SINCE` con el instante real de puesta en marcha y `CRM_FORM_WELCOME_ENABLED=true`. Requiere menú y Chivi oficiales activos. Desactivar ese último indicador detiene nuevas reservas sin borrar historial. Una prueba aislada de código no demuestra recepción física en WhatsApp.
