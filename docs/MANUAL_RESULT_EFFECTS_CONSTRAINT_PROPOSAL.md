# Propuesta histórica, sustituida tras preflight QA

**No aplicar el índice de este borrador.** QA ya tiene un índice único válido/ready para el partido de torneo; el snapshot local que motivó esta propuesta lo omitía. El candidato actual lo reutiliza. Ver `MANUAL_RESULT_DURABLE_EFFECTS.md` y `sql/candidates/20260911003000_manual_result_durable_effects.sql`. Se conserva debajo la propuesta anterior como antecedente, sin autorización de ejecución.

No aplicar esta propuesta en esta entrega. El preflight asociado es sólo lectura de metadatos y conteos agregados. No borra, fusiona, corrige ni selecciona filas ganadoras. Este lote mantiene la nueva escritura OFF.

Causa comprobable: `ensureScoreboardForCompletedBracketPartido` consulta scoreboards existentes y después inserta, en transacciones separadas. No se observó un índice único para el partido de torneo en el esquema local estructural. Dos workers que lean vacío pueden insertar dos scoreboards. El avance de ganador también lee un slot y luego hace UPDATE sólo por id, sin comparación de su valor/estado anterior. El guardado resultado/fecha sí es transaccional, pero esa transacción termina antes de los efectos.

Propuesta mínima a revisar después del preflight: una unicidad parcial que impida más de un scoreboard activo por `partido_torneo_id`, compatible con la selección actual de terminados. Es sólo una propuesta textual:

```sql
CREATE UNIQUE INDEX scoreboard_one_active_per_torneo_match
ON public.scoreboard_partidos(partido_torneo_id)
WHERE partido_torneo_id IS NOT NULL
  AND coalesce(lower(btrim(estado)),'') NOT IN ('terminado','finalizado');
```

La definición de activo requiere confirmación frente a estados reales y escritores existentes. Si el preflight encuentra duplicados, no ejecutar el índice ni deduplicar automáticamente. Las filas conservan datos deportivos/token/historial que requieren una decisión específica. Para instalación online habrá que decidir bloqueo/ventana o índice concurrente y verificar su estado válido; no presentar esta sentencia aislada como un plan de instalación.

Además de la restricción, el escritor que recibe un conflicto único debe releer el scoreboard ganador y devolverlo; no fabricar otro token ni tratar el conflicto como guardado deportivo fallido. Todos los caminos que crean o reabren scoreboards deben mantener el mismo invariante. El avance de ganador necesita UPDATE condicional sobre slot todavía vacío, torneo esperado y estado protegido; si afecta cero filas, releer y clasificar mismo ganador como idempotente u otro ganador como conflicto. Las pruebas deben cubrir dos semifinales, dos workers, reintento tras perder respuesta, destino iniciado/finalizado y carrera con generación manual por lote.

Implementado en este lote: si el avance ya ocurrió, reintentar también el paso de asegurar scoreboard; un resultado/fecha ya guardado devuelve `effects_pending` ante fallo/conflicto sin afirmar que se completaron sus efectos. Eso repara reintentos secuenciales y comunica el estado real. No elimina la carrera entre workers ni garantiza reparación autónoma sin reintento; por eso la capacidad de escritura permanece OFF y la garantía durable es el lote siguiente.
