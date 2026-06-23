export const MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS = 'partidos_abiertos';

export const MATCH_SUMMARY_STATUSES = Object.freeze([
  'pending',
  'generated',
  'failed',
  'skipped',
]);

function assertPgPool(pgPool) {
  if (!pgPool || typeof pgPool.query !== 'function') {
    const err = new Error('pgPool no disponible');
    err.status = 503;
    err.code = 'PG_POOL_UNAVAILABLE';
    throw err;
  }
}

function mapMatchSummaryRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    partido_id: row.partido_id,
    source_type: row.source_type,
    version: row.version,
    prompt_version: row.prompt_version ?? null,
    payload_hash: row.payload_hash,
    payload: row.payload ?? null,
    response: row.response ?? null,
    status: row.status,
    error_code: row.error_code ?? null,
    error_message: row.error_message ?? null,
    generated_at: row.generated_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * @param {{ partidoId: number|string, sourceType?: string, payloadHash: string, pgPool: import('pg').Pool }} params
 * @returns {Promise<object|null>}
 */
export async function getMatchSummaryByPayloadHash({
  partidoId,
  sourceType = MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS,
  payloadHash,
  pgPool,
}) {
  assertPgPool(pgPool);

  const parsedPartidoId = parseInt(String(partidoId), 10);
  if (!Number.isFinite(parsedPartidoId) || parsedPartidoId <= 0) {
    const err = new Error('partidoId inválido');
    err.status = 400;
    err.code = 'PARTIDO_ID_INVALIDO';
    throw err;
  }

  if (!payloadHash || typeof payloadHash !== 'string') {
    const err = new Error('payloadHash requerido');
    err.status = 400;
    err.code = 'PAYLOAD_HASH_REQUERIDO';
    throw err;
  }

  const { rows } = await pgPool.query(
    `SELECT
      id,
      partido_id,
      source_type,
      version,
      prompt_version,
      payload_hash,
      payload,
      response,
      status,
      error_code,
      error_message,
      generated_at,
      created_at,
      updated_at
    FROM partido_resumenes
    WHERE partido_id = $1
      AND source_type = $2
      AND payload_hash = $3
    LIMIT 1`,
    [parsedPartidoId, sourceType, payloadHash],
  );

  return mapMatchSummaryRow(rows[0] ?? null);
}

/**
 * @param {{
 *   partidoId: number|string,
 *   sourceType?: string,
 *   version: string,
 *   promptVersion?: string|null,
 *   payloadHash: string,
 *   payload: object,
 *   pgPool: import('pg').Pool,
 * }} params
 * @returns {Promise<object>}
 */
export async function createPendingMatchSummary({
  partidoId,
  sourceType = MATCH_SUMMARY_SOURCE_TYPE_PARTIDOS_ABIERTOS,
  version,
  promptVersion = null,
  payloadHash,
  payload,
  pgPool,
}) {
  assertPgPool(pgPool);

  const parsedPartidoId = parseInt(String(partidoId), 10);
  if (!Number.isFinite(parsedPartidoId) || parsedPartidoId <= 0) {
    const err = new Error('partidoId inválido');
    err.status = 400;
    err.code = 'PARTIDO_ID_INVALIDO';
    throw err;
  }

  if (!version || typeof version !== 'string') {
    const err = new Error('version requerida');
    err.status = 400;
    err.code = 'VERSION_REQUERIDA';
    throw err;
  }

  if (!payloadHash || typeof payloadHash !== 'string') {
    const err = new Error('payloadHash requerido');
    err.status = 400;
    err.code = 'PAYLOAD_HASH_REQUERIDO';
    throw err;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const err = new Error('payload requerido');
    err.status = 400;
    err.code = 'PAYLOAD_REQUERIDO';
    throw err;
  }

  const insertResult = await pgPool.query(
    `INSERT INTO partido_resumenes (
      partido_id,
      source_type,
      version,
      prompt_version,
      payload_hash,
      payload,
      status
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')
    ON CONFLICT (partido_id, source_type, payload_hash) DO NOTHING
    RETURNING
      id,
      partido_id,
      source_type,
      version,
      prompt_version,
      payload_hash,
      payload,
      response,
      status,
      error_code,
      error_message,
      generated_at,
      created_at,
      updated_at`,
    [
      parsedPartidoId,
      sourceType,
      version,
      promptVersion,
      payloadHash,
      JSON.stringify(payload),
    ],
  );

  if (insertResult.rows[0]) {
    return mapMatchSummaryRow(insertResult.rows[0]);
  }

  const existing = await getMatchSummaryByPayloadHash({
    partidoId: parsedPartidoId,
    sourceType,
    payloadHash,
    pgPool,
  });

  if (!existing) {
    const err = new Error('No se pudo crear ni recuperar resumen pendiente');
    err.status = 500;
    err.code = 'MATCH_SUMMARY_CREATE_FAILED';
    throw err;
  }

  return existing;
}

/**
 * @param {{ id: number|string, response: object, pgPool: import('pg').Pool }} params
 * @returns {Promise<object|null>}
 */
export async function markMatchSummaryGenerated({ id, response, pgPool }) {
  assertPgPool(pgPool);

  const parsedId = parseInt(String(id), 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    const err = new Error('id inválido');
    err.status = 400;
    err.code = 'MATCH_SUMMARY_ID_INVALIDO';
    throw err;
  }

  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    const err = new Error('response requerido');
    err.status = 400;
    err.code = 'RESPONSE_REQUERIDO';
    throw err;
  }

  const { rows } = await pgPool.query(
    `UPDATE partido_resumenes
     SET
       response = $2::jsonb,
       status = 'generated',
       error_code = NULL,
       error_message = NULL,
       generated_at = NOW(),
       updated_at = NOW()
     WHERE id = $1
     RETURNING
       id,
       partido_id,
       source_type,
       version,
       prompt_version,
       payload_hash,
       payload,
       response,
       status,
       error_code,
       error_message,
       generated_at,
       created_at,
       updated_at`,
    [parsedId, JSON.stringify(response)],
  );

  return mapMatchSummaryRow(rows[0] ?? null);
}

/**
 * @param {{
 *   id: number|string,
 *   errorCode?: string|null,
 *   errorMessage: string,
 *   pgPool: import('pg').Pool,
 * }} params
 * @returns {Promise<object|null>}
 */
export async function markMatchSummaryFailed({
  id,
  errorCode = null,
  errorMessage,
  pgPool,
}) {
  assertPgPool(pgPool);

  const parsedId = parseInt(String(id), 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    const err = new Error('id inválido');
    err.status = 400;
    err.code = 'MATCH_SUMMARY_ID_INVALIDO';
    throw err;
  }

  if (!errorMessage || typeof errorMessage !== 'string') {
    const err = new Error('errorMessage requerido');
    err.status = 400;
    err.code = 'ERROR_MESSAGE_REQUERIDO';
    throw err;
  }

  const { rows } = await pgPool.query(
    `UPDATE partido_resumenes
     SET
       status = 'failed',
       error_code = $2,
       error_message = $3,
       updated_at = NOW()
     WHERE id = $1
     RETURNING
       id,
       partido_id,
       source_type,
       version,
       prompt_version,
       payload_hash,
       payload,
       response,
       status,
       error_code,
       error_message,
       generated_at,
       created_at,
       updated_at`,
    [parsedId, errorCode, errorMessage],
  );

  return mapMatchSummaryRow(rows[0] ?? null);
}

/**
 * Elimina resúmenes cacheados de un partido para forzar regeneración.
 * @param {{ partidoId: number|string, pgPool: import('pg').Pool }} params
 */
export async function deleteMatchSummariesForPartido({ partidoId, pgPool }) {
  assertPgPool(pgPool);

  const parsedPartidoId = parseInt(String(partidoId), 10);
  if (!Number.isFinite(parsedPartidoId) || parsedPartidoId <= 0) {
    const err = new Error('partidoId inválido');
    err.status = 400;
    err.code = 'PARTIDO_ID_INVALIDO';
    throw err;
  }

  const { rowCount } = await pgPool.query(
    'DELETE FROM partido_resumenes WHERE partido_id = $1',
    [parsedPartidoId],
  );

  return { deleted: rowCount ?? 0 };
}
