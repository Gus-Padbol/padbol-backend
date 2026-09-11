# Resultado manual: efectos durables, candidato local OFF

Este lote agrega una transacción privada para avanzar la llave y asegurar su scoreboard siguiente. El resultado deportivo y su fecha ya se guardan juntos en `registrar_fecha_juego_manual`. El escritor llama después a `aplicar_efectos_resultado_manual_durable`; si falla, conserva la confirmación del resultado/fecha y comunica `effects_pending:true`. El reintento con los mismos datos recupera lo ya guardado. No hay reparación autónoma ni formulario nuevo. Escritura y lectura manual siguen OFF.

## Evidencia real y límite del índice

Root obtuvo metadatos QA el 2026-09-10 a las 23:55:43 y 23:57:04 UTC. Existe `idx_scoreboard_partidos_partido_torneo_activo`, UNIQUE, válido y ready, sobre `partido_torneo_id` con predicado `partido_torneo_id IS NOT NULL AND estado <> ALL(ARRAY['terminado','finalizado'])`. No había grupos duplicados, scoreboards activos, enlaces cruzados ni destinos con múltiples fuentes según esos conteos. El snapshot estructural anterior omitía ese índice: su reproducción de duplicados era exclusivamente local y no demuestra ausencia de unicidad en QA.

`estado` admite NULL y tiene default `pendiente`. El índice no cubre NULL. El candidato **no crea otro índice**: exige el existente con su definición/validez esperadas, rechaza duplicados y estados NULL, vacíos o distintos de los cuatro usados por el motor (`pendiente`, `en_curso`, `terminado`, `finalizado`). Nunca borra, fusiona, normaliza ni elige una fila para reparar datos. La consulta de preflight sólo devuelve metadatos y conteos agregados.

El servicio nuevo inserta siempre `pendiente` y vuelve a comprobar los estados persistidos. Rechaza una fila ambigua con conflicto y revierte el avance de esa transacción. No se promete que el índice impida NULL escritos por otros caminos: dos filas NULL pueden coexistir, como verifica una prueba local. Un eventual NOT NULL o CHECK global exige un lote separado y revisión de todos los escritores; aquí no se agrega ni se rellenan estados automáticamente.

## Concurrencia y contrato

La RPC bloquea origen y destino por id en orden estable. Revalida torneo/sede, actor vinculado, permiso vigente, revisión privada, resultado y equipos del snapshot; deriva ganador y verifica el guardado. Sólo escribe un slot vacío en destino pendiente/programado. Mismo ganador es reutilización; otro ganador o destino iniciado/protegido es conflicto. Dos semifinales a slots opuestos conservan ambos ganadores; un contexto obsoleto devuelve `40001` y el servicio vuelve a leer una vez. Tras dos intentos sin confirmación comunica pendiente.

Al completar ambos equipos, la misma transacción verifica bajo bloqueo los datos usados por `buildScoreboardInsertRow`, el constructor ya existente. Crea o recupera un único scoreboard con el índice real y `ON CONFLICT DO NOTHING`, y comprueba el ámbito, nombres y jugadores de la fila recuperada. Un marcador incompatible produce conflicto sin sobrescribirlo. Cualquier error de inserción revierte también el avance, manteniendo el resultado/fecha de la transacción anterior. La RPC sólo admite `service_role`; anon/authenticated no reciben ejecución. El actor proviene del guard JWT del escritor.

El helper previo de avance ahora actualiza comparando slot vacío, torneo y estado leídos; si otro trabajador cambió el destino, relee y comunica reutilización o conflicto. El helper previo de scoreboard detecta duplicados y recupera `23505` leyendo una única fila compatible de torneo/sede, sin rotar su token. Esto también protege el flujo digital anterior frente a esas carreras sin cambiar su cálculo deportivo.

## Tokens, privacidad y límites de integración

La RPC nueva no emite ni rota tokens: una fila nueva nace sin token. La emisión administrativa existente está en `POST /api/scoreboard/partidos/:id/control-token`, con autenticación y control de sede. Integrar el formulario/control futuro requerirá conectar esa acción explícita si corresponde; no se devuelve un token desde la respuesta nueva de resultado. Reutilizar una fila preserva token, puntos y colores. Las pruebas usan sólo datos y hashes sintéticos.

No hay nuevas tablas de personas ni nuevos destinatarios. El template usa los jugadores ya persistidos de los equipos del **próximo partido** para su marcador. No reconstruye participantes del partido histórico ni modifica la evidencia de actividad mensual. La fecha sigue siendo declarada, con actor JWT y timestamp servidor aparte; no prueba presencia física. Se preservan final digital, cuatro metas conjuntas, 12 reservas, 10 personas distintas, jugador 0%, precios vigentes y cobros OFF.

El candidato requiere el contrato privado anterior y el índice QA. No fue aplicado remotamente. Las pruebas PostgreSQL usan tablas estructurales sintéticas con el índice real, las dos RPC y roles; no reproducen todas las FK, RLS, triggers y permisos de QA. La activación requiere revisar el comportamiento bajo ese esquema completo, estados ambiguos y acceso al control del marcador. La ausencia de índice o un esquema distinto aborta la instalación para revisión.

## Validación

Suite backend completa Node 22: 1790/1790. PostgreSQL 17.6 real: 26 casos, incluyendo llamadas concurrentes al escritor, mismo slot/slots opuestos, ganador conflictivo, rollback, pérdida de respuesta, cambio de plantel/fecha/permiso, inserción legacy que gana al RPC, `unique_violation` legacy, CAS concurrente, historia terminal, permisos públicos y rechazo de duplicados/NULL/índice ausente. Los archivos reproducibles y hashes acompañan la entrega del lote; no se modifican los artefactos congelados anteriores.
