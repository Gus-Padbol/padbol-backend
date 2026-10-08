# Capacidad de fecha declarada — endpoint local OFF

Esta copia monta sólo la consulta de disponibilidad propuesta por el cliente web aislado. `writeEnabled` y `readEnabled` siguen en `false`. No se monta el formulario, no se modifica el guardado legacy y no se aplica SQL. El endpoint no registra fechas, resultados, revisiones, efectos, tokens o actividad mensual.

## Contrato de consulta

`GET /api/torneos/:torneoId/partidos/:partidoId/fecha-juego/capacidad`, con el JWT existente. No recibe actor, sede, permisos ni operaciones desde body/query. Los IDs de ruta deben ser enteros positivos seguros. La respuesta de un operador autorizado es:

```json
{
  "schema": "torneo-manual-date/v1",
  "enabled": false,
  "user_id": "UUID del actor autenticado",
  "torneo_id": 1,
  "partido_id": 2,
  "sede_id": 3,
  "operations": { "declare": false, "correct": false },
  "expires_at": "2026-09-10T20:01:00.000Z"
}
```

La expiración se calcula con reloj del servidor a 60 segundos de la evaluación. Respuestas y errores llevan `Cache-Control: private, no-store`, `Pragma: no-cache` y `Vary: Authorization`. No hay datos de participantes, operador de la declaración, auditoría, motivos, resultados ni tokens en el DTO. `user_id` corresponde sólo al solicitante.

Primero verifica el JWT con `getAuthenticatedUser`, sin usar el guard administrativo compartido: ese guard puede vincular asignaciones pendientes por email. Este GET no consulta ni vincula roles por email. Consulta el vínculo ya persistido por `user_roles.user_id`: exige exactamente una fila, `super_admin` o `admin_club` con sede explícita e igual a la del torneo/partido. Un rol heredado por email, permiso territorial/de lectura, sede nula de admin_club, rol revocado/indebido o duplicados no permiten la nueva capacidad. También exige sede explícita del partido, por coherencia con el contrato durable. Identidad ausente devuelve 401; permiso/ámbito denegado 403; partido/torneo faltante o relación incorrecta 404; parámetros inválidos 400; datos privados no disponibles o error inesperado 503. Errores internos se omiten. Los guards de las demás rutas no cambian.

Con OFF sólo lee torneo, partido y vínculo de rol; no consulta equipos ni la RPC privada. Por eso la consulta OFF funciona antes de instalar las migraciones privadas. `readEnabled` gobierna el evaluador mensual: su valor no habilita escritura del formulario. Sólo el booleano literal `writeEnabled: true`, suministrado por código del servidor, permite calcular operaciones. No se agrega un interruptor por petición, variable de entorno o almacenamiento del navegador.

## Operaciones cuando se habiliten en otro lote

- `declare`: partido nuevo de Padbol/dobles con dos equipos distintos confirmados del torneo/sede, sin resultado previo, en estado pendiente/en_curso/activo y torneo en_curso/activo. También un resultado manual ya finalizado con ganador conocido entre sus equipos; esta segunda condición conserva el reintento de la declaración original y los efectos pendientes con los mismos bytes/revisión 0.
- `correct`: resultado manual finalizado y declaración privada vigente. Una declaración invalidada o un estado incoherente no habilitan operaciones. La corrección requiere motivo y revisión en el PUT existente; el endpoint no evita sus validaciones SQL. Un torneo cerrado puede corregir una fecha manual ya registrada sin cambiar cierre o evidencia digital.
- Un resultado digital no se ofrece como manual. Se admite la procedencia manual explícita y el formato legacy con set1/set2 sin procedencia, consistente con el contrato previo. No se leen equipos actuales para corregir/declarar fecha sobre un resultado histórico; no se reconstruyen integrantes legacy.

Antes de ofrecer cualquier operación ON, usa `leer_fecha_juego_manual`, que vuelve a autorizar actor y ámbito dentro de la transacción privada de lectura. Una revocación detectada allí deniega la capacidad. Sólo se recibe el DTO mínimo de declaración. El endpoint es una fotografía orientativa: no bloquea el estado hasta el futuro POST/PUT ni sustituye la autorización SQL, normalización completa del resultado, validación de sus cuatro UUIDs, revisión optimista o garantías de efectos. Cambios concurrentes posteriores pueden producir rechazo/conflicto al escribir; el formulario debe recargar. No hay nueva garantía transaccional de permisos más allá de cada contrato existente.

## Base exacta y montaje futuro

Base de esta entrega: snapshot de `/private/tmp/padbol-director2-qa-integration-20260910/backend` (529 archivos), más el parche durable congelado `bfbb3760b46fb15b2938905eceb84d8e5796c999dd3ee718a38ac19756bde2af` aplicado exclusivamente en la copia propia. `endpoint-base-manifest.json` registra los 533 hashes de la base efectiva; `source-manifest.json` registra el snapshot original. El delta del endpoint no repite los 13 archivos del parche durable.

Dependencias para una futura activación de escritura:

1. Contrato `20260910233000_manual_match_played_date.sql`, SHA-256 `a0362b7874ff7a10741e7a079db12d527b7a4c57fbcdebf3eab3117587163550`.
2. Escritor/servicio durable del parche indicado y candidato `20260911003000_manual_result_durable_effects.sql`, SHA-256 `c2826d63777ca18ca5b32d0bae4c303f976d6c4a5a8d86c5d74452d2b23c2085`, con su envoltura de instalación revisada en el lote asignado a otro agente. Este endpoint no cambia ni instala ese SQL.
3. Esquema/roles/índice QA verificados en su lote. El índice QA ya existe, unique/valid/ready; el snapshot anterior que omitía el índice no representa su ausencia en QA. No se crea restricción redundante y no se presume que cubra estado NULL.

La consulta se registra junto al GET/PUT de fecha existentes en `server.js`; verifica JWT y vínculo persistido sin ejecutar el guard administrativo compartido. GET/PUT de fecha y POST de resultado conservan sus guards existentes y la autorización SQL de cada operación. El formulario aislado de la entrega web `50e190b5769765961cf22069efef98013c141215591b04666365b50561809961` puede consumir exactamente este contrato una vez integrado y autorizado su montaje. Sigue pendiente conectar sus callbacks de bloqueo de borrador/resultado/voz, recarga por usuario/sede/partido y expiración. OFF/desconocido/error conserva el flujo legacy; una escritura explícita con fecha rechazada no debe caer automáticamente al guardado legacy descartándola. Para `effects_pending`, conservar la confirmación del resultado/fecha y permitir reintento idéntico. La emisión de token administrativo de control de scoreboard permanece en su acción existente separada.

No se monta el formulario ni se habilitan flags aquí. Continúan final digital del torneo, cuatro metas conjuntas, 12 reservas, 10 personas distintas, jugador 0%, precios vigentes y cobros OFF sin cambios. La fecha es declarada; no prueba presencia física y no se deduce de programación, created_at o cierre. No SQL remoto, navegadores, proveedores, pagos, publicaciones o datos reales en este lote.
