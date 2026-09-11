# Inventario de origen, alcance e impacto

Fecha de preparación: 10/09/2026. Revisión por lectura de archivos, sin recorrer chats ni consultar proveedores. La base inspeccionada es QA `6b9b60ad3da4d3e5052ba1f3157e31496600dbf4`, copia local `/private/tmp/padbol-whatsapp-qa-scoped-send-20260910`. Los hashes de las referencias quedan en `evidence/source-inventory.json`.

| Referencia | Hallazgo y consecuencia para este lote |
| --- | --- |
| `lib/whatsappCloud.js` | El servicio crea una salida con `channel.auto_reply_text` o el texto genérico. Ya tiene persistencia, firma, ventana e idempotencia propios. No aparece un editor de respuestas ni contrato de temas. No se modificó. |
| `lib/whatsappQaSandboxSend.js` | Factory de QA con ámbito exacto y respuesta fija comprobada. Cambiar su texto invalidaría el ensayo. No se importa ni modifica. |
| `lib/releaseServices.js`, `server.js`, `lib/backendRuntime.js` | Montaje y restricciones de runtime existentes. Este paquete no se conecta a ellas ni cambia variables. |
| `src/routes/chivi.js`, `src/services/chiviChat.js` | Chivi tiene chat público y autenticado, y llama a Anthropic con texto/contexto. La bandera `whatsapp_escalada` del chat público se calcula con una expresión regular de interés comercial; no demuestra envío ni derivación humana. No se importa ni ejecuta ese servicio. |
| `src/config/chiviContext.js`, `src/ai/prompts/chiviGeneralV1.js` | Reglas y conocimiento con límites a precios y promesas. El prompt declara 7 idiomas, un dato histórico que no se reutiliza frente a la web actual de 20. La configuración de este lote no copia contenido comercial. |
| App nativa `src/lib/chivi.js`, `src/components/home/ChiviChatModal.js` | Cliente de chat autenticado y panel con voz/acciones. No es un editor por tenant de respuestas WhatsApp. No se modifica ni se prueba dispositivo en este lote. |
| Web `src/constants/hubChiviConfig.js`, `src/hooks/useHubChiviAvatar.js` | Configuración de avatar, no contrato de respuestas. Se leyó la copia web del paquete de seguridad; no se modificó. |
| Proyecto: `PLAN_CIERRE_LANZAMIENTO_2026-09-14.md`, `PENDIENTES_PADBOL_2026-09-10.md`, `CONTINUIDAD_PADBOL_2026-09-10/LEER_PRIMERO.md`, `whatsapp-cierre-propio-20260910/CIERRE_WHATSAPP_01_02.md` | Describen atención/CRM como pendiente distinto del ensayo fijo y no permiten prometer operación humana sin definirla. Sus estados antiguos de token y WABA son históricos: la instrucción actual del coordinador mantiene el sandbox ya publicado fuera de este lote. Documentos tratados como referencia, no nuevas órdenes. |

Impacto del módulo nuevo: únicamente estructuras en memoria y archivos de ejemplo sintéticos; no nueva recopilación, persistencia, log de contenido, permiso, rol, cookie, SDK, proveedor, envío, campaña o modificación de política. Los errores contienen códigos y rutas, sin texto ni identidad suministrada. El contexto admite sólo tenant, borrador, revisión e idioma; no admite remitente, teléfono, conversación, texto recibido, operador ni credenciales.

El módulo acepta texto `unapproved` para un editor futuro. Su mera validación no revisa legalidad ni exactitud comercial. Al instalar persistencia/editor habrá que definir quién puede editar, historial de autoría, retención y eliminación, y actualizar el inventario de privacidad de la aplicación con los datos realmente tratados. No se cambian documentos legales, políticas o declaraciones de tiendas en este lote local.

Hallazgos previos acotados para no heredarlos: el helper nativo de Chivi registra el cuerpo de consulta/contexto en modo desarrollo y el servicio backend construye errores con cuerpos del proveedor; no se reutilizan esos patrones. Son código ya existente y no se ejecutó ni se auditó exhaustivamente su operación. Una futura integración con Chivi debe revisar minimización de datos y registros antes de usar conversaciones WhatsApp.

No se acredita aislamiento de una API de configuración todavía inexistente: el chequeo local de tenant compara valores y requiere que una futura capa autenticada suministre un contexto confiable. La verificación local cubre este contrato; no cierra la atención WhatsApp02 en producción.
