# Integración local: escritor manual y actividad mensual por fecha declarada

Estado: integrada y probada sólo en copia aislada. **Escritura nueva OFF; lectura manual del evaluador OFF.** No instalar migraciones ni activar capacidades como consecuencia automática de integrar estos archivos. No hay formulario nuevo ni modificación web/nativa.

## Comportamiento implementado

El POST administrativo de resultado conserva `requireTorneoAdminByTorneoId` y toma actor del usuario autenticado. Solicitudes sin `fecha_juego` siguen el flujo vigente. Si la propiedad existe, el servidor exige la capacidad de escritura; mientras está OFF devuelve 409 `MANUAL_PLAYED_DATE_DISABLED` y no guarda parcialmente el resultado ni descarta silenciosamente la fecha.

Cuando se habilite tras revisión del candidato y del esquema destino, el escritor llama una sola vez al contrato SQL para guardar resultado, ganador, fecha, snapshot de participantes y auditoría. No combina el escritor anterior con una segunda escritura de fecha. Un error de contrato no ejecuta efectos. Si el commit se confirmó pero falla la llave o scoreboard, devuelve el resultado/fecha guardados y `effects_pending:true`, con código `MANUAL_RESULT_SAVED_EFFECTS_PENDING`; no expone error interno ni token de control. El cliente futuro debe conservar los mismos datos para reintentar. No se implementa reparación autónoma sin un reintento.

La orquestación compartida ahora vuelve a asegurar scoreboard si el ganador ya había avanzado (`ya_avanzado`), y considera fallidos los efectos que devuelven `failed`/`conflict` sin lanzar. Esto corrige la interrupción entre ambos pasos en reintentos secuenciales. El lote durable agrega una RPC transaccional al flujo nuevo, recuperación del conflicto único y comparación de slot en el helper previo; ver `MANUAL_RESULT_DURABLE_EFFECTS.md`.

Las rutas GET/PUT de fecha se montan con guard administrativo y capacidad de escritura OFF. Una corrección de fecha usa la RPC sin resultado; no modifica ganador ni dispara efectos deportivos. Las capacidades son constantes del servidor en `manualPlayedDateCapability.js`, no valores aceptados de un body o flag público. La lectura manual del evaluador puede habilitarse por separado; continúa OFF por defecto. Las pruebas usan una inyección interna explícita, no una vía del cliente.

## Evaluador

Cuando la lectura manual se habilite, el evaluador busca declaraciones vigentes de la sede y mes por `fecha_juego`, paginando sobre la clave real `partido_id`; descubre también torneos aún abiertos. La lectura trae los campos privados estrictamente necesarios y el resultado agregado no devuelve actor, motivo ni UUIDs.

Sólo acepta evidencia que coincide con resultado, ganador, equipos y ámbito persistidos. Obtiene participantes del snapshot histórico, aunque la composición actual del equipo cambie o el equipo ya no esté en la consulta. Los cuatro UUIDs deben ser distintos, tener cuenta real no eliminada/anónima, perfil, email o teléfono confirmado y vínculo activo con esa sede. No sustituye un snapshot ausente con el plantel actual. Un resultado manual legacy sin participantes históricos sigue aportando resultado deportivo, pero no inventa actividad mensual por personas.

El marcador digital mantiene prioridad: si un partido tiene puntos digitales válidos, su actividad sigue el mes del punto; una declaración manual no la desplaza a otro mes. Una declaración sin snapshot no elimina actividad digital existente. Una fila activa que reemplaza el scoreboard impide reciclar evidencia manual obsoleta. El requisito de final digital para torneo no cambia; los demás partidos pueden tener resultados manuales.

Se deduplican personas dentro del mes y se permite que vuelvan a contar en otro mes con otro partido. Si la lectura manual habilitada falla, se conserva el mínimo conocido: diez o más personas ya demostradas bastan para esa meta; si el total pudiera quedar por debajo del mínimo, el criterio queda desconocido y `jugadores_activos_conteo_minimo_conocido` conserva el conteo observado. Con la lectura OFF, no se consulta la tabla nueva ni cambia el comportamiento digital previo.

No se cambió la versión ni umbrales de metas, las cuatro condiciones conjuntas, 12 reservas, 10 personas distintas, precios de sede, jugador 0%, previews sin persistencia o cobros OFF. Las dos metas de torneo conservan sus verificaciones actuales; no se reconstruyen nuevos históricos de planteles para ellas en este lote.

## Garantía local y condiciones de activación

La reproducción anterior con dos scoreboards pertenecía a un snapshot estructural local que omitía el índice único existente en QA. El preflight real del coordinador confirmó `idx_scoreboard_partidos_partido_torneo_activo` válido/ready y `estado` nullable. El nuevo candidato reutiliza ese índice, valida estados y rechaza ambigüedad; no crea una restricción redundante ni repara filas.

La llave y scoreboard del flujo nuevo se realizan en una transacción privada, con reintento y conflictos explícitos. Sigue OFF por revisión de esquema completo, tratamiento de estados ambiguos y futuro enlace con la emisión administrativa del control. Ver el contrato, pruebas y límites actuales en `MANUAL_RESULT_DURABLE_EFFECTS.md`. Los artefactos congelados de la entrega anterior conservan la evidencia histórica local.

## Evidencia y límites

La entrega incluye suite completa del backend en Node 22, pruebas del escritor/lectura/evaluador y siete recorridos PostgreSQL integrados. Esos recorridos usan el escritor real con el adaptador de RPC a PostgreSQL; la evaluación recibe filas reales de la tabla privada y usa cuentas/vínculos sintéticos. La prueba de carrera usa la función real de scoreboard con un punto de sincronización que hace coincidir las dos lecturas; el token se sustituye por null en el ensayo y no se emiten secretos reales.

Se usaron tablas locales aisladas derivadas del esquema estructural del 2026-09-09; no se reproducen todas las claves foráneas, triggers o permisos heredados. No se ejecutó el servidor completo con PostgREST/servicios reales, SQL remoto, activación, frontend o app física. Los tests HTTP de la suite completa usan servidores temporales locales. Las filas de ensayo quedan vacías al terminar; el contenedor compartido permanece intacto.

La migración del contrato no cambió respecto de la entrega anterior de 127 comprobaciones. Retención, eliminación/exportación y transparencia previa siguen pendientes antes de activar registros reales; el snapshot contiene identificadores personales y no equivale a presencia física verificada. Ver la nota incremental de privacidad en el paquete de entrega.
