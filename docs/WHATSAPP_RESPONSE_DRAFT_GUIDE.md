# WhatsApp02: configuración de respuestas, preparación local

Está implementado un contrato de borrador por tenant y una vista previa determinista. No hay editor instalado, motor conversacional, asistente IA, publicación de contenido ni envío. WhatsApp01 y su respuesta fija quedan fuera de este paquete.

## Archivos y uso

- `lib/whatsappResponseDraft.js`: módulo puro ESM, sin dependencias, almacenamiento, variables de entorno ni llamadas externas.
- `schema/whatsapp-response-draft.v1.schema.json`: estructura JSON Schema Draft 7 para un futuro formulario. Las reglas de IDs únicos y referencias entre temas y respuestas también requieren `validateResponseDraft`.
- `examples/synthetic-draft.json`: datos ficticios identificados con `[SINTÉTICO]`, sin contenido comercial ni tenant real.
- `lib/whatsappResponseDraft.test.js`: pruebas locales ejecutables con Node 22 `node --test lib/whatsappResponseDraft.test.js`.

```js
import { createResponseDraft, reviseResponseDraft, previewResponseDraft } from './lib/whatsappResponseDraft.js';

const created = createResponseDraft({
  tenantId: '00000000-0000-4000-8000-000000000001',
  draftId: '00000000-0000-4000-8000-000000000002', locale: 'es',
});
const current = created.draft;
const context = { tenantId: current.tenantId, draftId: current.draftId,
  revision: current.revision, locale: current.locale };
const edited = reviseResponseDraft(current, {
  greeting: { text: '[SINTÉTICO] Saludo pendiente de revisión.' },
}, context);
const result = previewResponseDraft(edited.draft, { kind: 'greeting' }, {
  ...context, revision: edited.draft.revision,
});
// result.ok === true, result.complete === false, result.dispatchAllowed === false
```

La revisión empieza en 1. Cada edición aceptada incrementa una vez la revisión; el tenant, ID, versión de esquema y estado no son editables. Una revisión vieja da `REVISION_CONFLICT`. Esto permite preparar el control de concurrencia, pero todavía no hay persistencia: dos procesos pueden calcular candidatos de revisión 2. El futuro guardado debe comparar e incrementar la revisión de forma atómica en servidor.

## Semántica de edición y vista previa

`validateResponseDraft` diferencia estructura válida de contenido completo. Un borrador vacío usa `null` en saludo, fallback y atención humana y listas vacías; se puede guardar. Un tema sin respuesta seleccionada usa `savedReplyId: null`. Una referencia no nula inexistente se rechaza. `complete` sólo describe que las secciones tienen contenido; jamás significa aprobado o apto para envío.

Los campos de texto presentes deben tener contenido y respetar límites de 2000 caracteres; los títulos de tema admiten 160 y cada lista 50 elementos. Son límites locales conservadores para el editor, sin afirmar compatibilidad con botones, listas o plantillas de Meta. Cada borrador contiene un idioma en formato `es` o `es-AR`; no traduce ni cambia silenciosamente de idioma. Los identificadores UUID usan minúsculas.

La vista previa recibe el contexto exacto `{ tenantId, draftId, revision, locale }` y una selección explícita:

| Selección | Resultado |
| --- | --- |
| `{ kind: 'greeting' }` | Texto de saludo, si existe. |
| `{ kind: 'menu' }` | Opciones con ID, título y disponibilidad de respuesta. |
| `{ kind: 'topic', id }` | Respuesta guardada enlazada al tema. |
| `{ kind: 'saved_reply', id }` | Respuesta guardada seleccionada. |
| `{ kind: 'fallback' }` | Texto alternativo elegido explícitamente. |
| `{ kind: 'human_request' }` | Vista previa del texto y `proposedAction: 'request_human_attention'`, `actionPerformed: false`. |

Una selección desconocida, tenant ajeno, versión o idioma distinto se rechaza antes de entregar texto. Una sección vacía devuelve `INCOMPLETE_DRAFT`; no se inventa contenido. Las secciones completas pueden previsualizarse aunque otras estén incompletas. No hay interpretación del texto entrante, historial ni memoria conversacional; aquí «contexto» significa el ámbito y versión de la vista previa.

Todos los resultados de vista previa llevan `previewOnly: true` y `dispatchAllowed: false`. El esquema sólo acepta `status: 'draft'`, `enabled: false` y `contentStatus: 'synthetic' | 'unapproved'`. Para introducir texto real se usa `unapproved`: eso no lo aprueba. Este código no evalúa plantillas, precios, horarios o promesas de atención. Renderizar el texto como texto plano, nunca como HTML; el módulo conserva las cadenas literalmente.

## Conexión propuesta con la bandeja

Propuesta de integración futura, sin editar archivos del agente `bandeja_whatsapp`:

1. Agregar una sección de borradores y vista previa en la bandeja. La selección de tenant y acceso deben provenir de la autorización vigente verificada en servidor; el contexto del navegador no autoriza nada por sí solo. Este módulo no agrega roles ni reemplaza autenticación.
2. Un repositorio separado leerá/escribirá configuración por tenant, ID de borrador e idioma. Validará en servidor y guardará revisiones con comparación atómica. Mantendrá el historial de versiones y la autoría según la política definida; este paquete no crea tablas ni migraciones.
3. La interfaz puede enviar selecciones de tema o respuesta a `previewResponseDraft`, mostrando siempre «Borrador / Vista previa / No enviado». El ID de conversación no se necesita para editar y no se entrega al resolutor. No pasar una salida de vista previa directamente a una acción de envío de la bandeja.
4. Si la futura bandeja permite pedir atención humana, implementará una acción separada y autorizada para registrar el pedido con idempotencia y tenant correcto. La vista previa actual no asigna operador, crea ticket ni promete plazos. Debe resolverse primero qué operación recibe esos pedidos.
5. La eventual publicación requiere un contrato distinto, contenido aprobado, control de versiones activas y pruebas integradas. La activación del envío, sus permisos, políticas y relación con la ventana de WhatsApp se resuelven fuera de este módulo. No sustituir el texto fijo del sandbox QA ni reutilizar sus permisos.

Los nombres de controles o endpoints son propuesta, no rutas instaladas. Puede integrarse el módulo en un editor más adelante sin cambiar el sender. No depende de que Juan Pablo envíe el mensaje de ensayo.

## Decisiones y trabajo pendientes

Faltan los textos reales por tenant/idioma y quién los aprueba; los temas y respuestas comerciales autorizados; los criterios y disponibilidad operativa de atención humana; la interfaz de edición y persistencia con autorización vigente; el contrato de publicación y selección de versión activa. Nada de ello impide revisar este contrato local.

Un asistente IA necesitaría su propio diseño de contexto, límites de datos, modelo/proveedor y evaluación. Este menú determinista no acredita un asistente IA ni CRM completo. No se llamó al servicio Chivi existente.

## Integración del paquete

El parche de entrega agrega únicamente módulo, prueba, esquema, ejemplo y esta guía/inventario bajo rutas nuevas de backend. No incluye `package.json` de este laboratorio, evidencias, cambios de servidor, dependencias ni rutas. Ejecutar las pruebas al copiarlo; el archivo de prueba busca el ejemplo en `../examples/`.
