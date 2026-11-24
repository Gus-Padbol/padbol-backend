import crypto from 'node:crypto';

// Contrato de sede: restauración del paso POST /api/sedes/:id/contrato que ya
// consume NuevaSede. No hay ledger nuevo: el UUID estable del intento es la PK
// de public.contratos_sedes, de modo que el mismo intento no puede duplicar la
// fila. Los contratos legítimos distintos no se deduplican por nombre/fecha/ref.
export const CONTRACT_PRIVATE_BUCKET = 'contratos-sedes-privados';
export const CONTRACT_STORAGE_COLUMN = 'storage_path';
export const CONTRACT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CONTRACT_REFERENCE_MAX_LENGTH = 240;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTRACT_FILE_EXTENSIONS = new Set(['pdf', 'jpg', 'png', 'webp']);

export function contractError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function parseSedeId(raw) {
  const text = String(raw ?? '').trim();
  if (!/^[1-9][0-9]{0,15}$/.test(text)) {
    throw contractError(400, 'sede_id_invalido', 'ID de sede inválido.');
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw contractError(400, 'sede_id_invalido', 'ID de sede inválido.');
  }
  return value;
}

export function parseContractUUID(raw, { required = false } = {}) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text) {
      const normalized = text.toLowerCase();
      if (!UUID_PATTERN.test(normalized)) {
        throw contractError(400, 'contrato_uuid_invalido', 'El identificador estable del contrato es inválido.');
      }
      return normalized;
    }
  } else if (raw != null) {
    // Un campo duplicado/inesperado no debe degradar a un UUID nuevo: eso
    // podría duplicar metadata. Sólo la ausencia real genera uno.
    throw contractError(400, 'contrato_uuid_invalido', 'El identificador estable del contrato es inválido.');
  }
  if (!required) return crypto.randomUUID();
  throw contractError(400, 'contrato_uuid_requerido', 'Falta el identificador estable del contrato.');
}

function parseIsoDate(raw, field) {
  if (typeof raw !== 'string') {
    throw contractError(400, `${field}_invalida`, `La fecha ${field} es inválida.`);
  }
  const match = ISO_DATE_PATTERN.exec(raw.trim());
  if (!match) {
    throw contractError(400, `${field}_invalida`, `La fecha ${field} debe tener formato AAAA-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw contractError(400, `${field}_invalida`, `La fecha ${field} es inválida.`);
  }
  if (year < 1900 || year > 2200) {
    throw contractError(400, `${field}_invalida`, `La fecha ${field} está fuera de rango.`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeReference(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw contractError(400, 'referencia_invalida', 'La referencia del contrato es inválida.');
  }
  const text = raw.trim();
  if (!text) return null;
  if (text.length > CONTRACT_REFERENCE_MAX_LENGTH) {
    throw contractError(400, 'referencia_invalida', 'La referencia del contrato es demasiado larga.');
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw contractError(400, 'referencia_invalida', 'La referencia del contrato contiene caracteres inválidos.');
  }
  return text;
}

export function validateContractMetadata({ raw = {}, sedeId } = {}) {
  const fechaInicio = parseIsoDate(raw.fecha_inicio, 'fecha_inicio');
  const vencimientoRaw = raw.fecha_vencimiento;
  const fechaVencimiento = vencimientoRaw == null || String(vencimientoRaw).trim() === ''
    ? null
    : parseIsoDate(vencimientoRaw, 'fecha_vencimiento');
  if (fechaVencimiento && fechaVencimiento < fechaInicio) {
    throw contractError(400, 'fecha_vencimiento_invalida', 'La fecha de vencimiento no puede ser anterior al inicio.');
  }
  return {
    sedeId,
    contratoUUID: parseContractUUID(raw.contrato_uuid ?? raw.contract_uuid),
    fecha_inicio: fechaInicio,
    fecha_vencimiento: fechaVencimiento,
    referencia: normalizeReference(raw.referencia),
  };
}

function fileSignature(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

// El nombre, MIME y path del cliente no se confían: se validan bytes reales y el
// path se deriva de sede + UUID estable + hash del contenido.
export function validateContractFile(file) {
  if (!file) return null;
  const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);
  if (!buffer.length) {
    throw contractError(400, 'archivo_invalido', 'El archivo del contrato está vacío.');
  }
  if (buffer.length > CONTRACT_FILE_MAX_BYTES) {
    throw contractError(413, 'archivo_demasiado_grande', 'El archivo del contrato supera el límite permitido.');
  }
  const signature = fileSignature(buffer);
  if (!signature) {
    throw contractError(400, 'archivo_invalido', 'El archivo del contrato no es un PDF o una imagen válida.');
  }
  const declaredMime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (declaredMime !== signature.mime) {
    throw contractError(400, 'archivo_mime_invalido', 'El tipo declarado del archivo no coincide con su contenido.');
  }
  return {
    buffer,
    mime: signature.mime,
    ext: signature.ext,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

export function contractStoragePath({ sedeId, contratoUUID, sha256, ext }) {
  if (!Number.isSafeInteger(sedeId) || sedeId <= 0) throw new Error('sedeId inválido para storage');
  if (!UUID_PATTERN.test(String(contratoUUID || ''))) throw new Error('contratoUUID inválido para storage');
  if (!SHA256_PATTERN.test(String(sha256 || ''))) throw new Error('sha256 inválido para storage');
  if (!CONTRACT_FILE_EXTENSIONS.has(ext)) throw new Error('extensión inválida para storage');
  return `${sedeId}/${contratoUUID}/${sha256}.${ext}`;
}

export function normalizePrivateStorageConfig(privateStorage) {
  if (privateStorage == null) return null;
  const bucket = String(privateStorage.bucket || '').trim();
  const column = String(privateStorage.column || '').trim();
  if (bucket !== CONTRACT_PRIVATE_BUCKET) {
    throw new Error(`Bucket privado de contratos no autorizado: ${bucket || '(vacío)'}`);
  }
  if (column !== CONTRACT_STORAGE_COLUMN) {
    throw new Error(`Columna de storage de contratos no autorizada: ${column || '(vacía)'}`);
  }
  // Un adaptador concreto conserva su upload; una config plana sólo declara
  // bucket/columna y el archivo queda cerrado hasta que exista adaptador.
  if (typeof privateStorage.upload === 'function') {
    return Object.freeze({ bucket, column, upload: privateStorage.upload.bind(privateStorage), ...(typeof privateStorage.download === 'function' ? { download: privateStorage.download.bind(privateStorage) } : {}) });
  }
  return { bucket, column };
}

export function isoDateFromRow(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text;
}

function comparableContract(row, hasStorage) {
  return {
    sede_id: Number(row?.sede_id),
    fecha_inicio: isoDateFromRow(row?.fecha_inicio),
    fecha_vencimiento: isoDateFromRow(row?.fecha_vencimiento),
    referencia: row?.referencia ?? null,
    storage_path: hasStorage ? (row?.[CONTRACT_STORAGE_COLUMN] ?? null) : null,
  };
}

function sameContract(row, expected, hasStorage) {
  const actual = comparableContract(row, hasStorage);
  return actual.sede_id === expected.sede_id
    && actual.fecha_inicio === expected.fecha_inicio
    && actual.fecha_vencimiento === expected.fecha_vencimiento
    && actual.referencia === expected.referencia
    && actual.storage_path === expected.storage_path;
}

export function contractReceipt(row, { file = null, storagePath = null, replayed = false } = {}) {
  return {
    ok: true,
    replayed: Boolean(replayed),
    contrato: {
      id: row.id,
      sede_id: Number(row.sede_id),
      fecha_inicio: isoDateFromRow(row.fecha_inicio),
      fecha_vencimiento: isoDateFromRow(row.fecha_vencimiento),
      referencia: row.referencia ?? null,
      created_at: row.created_at ?? null,
      archivo: storagePath && file
        ? {
          bucket: CONTRACT_PRIVATE_BUCKET,
          path: storagePath,
          sha256: file.sha256,
          size: file.size,
          mime: file.mime,
        }
        : null,
    },
  };
}

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key|unique constraint/i.test(String(error?.message || ''));
}

function isStorageDuplicate(error) {
  return String(error?.statusCode || error?.status || '') === '409'
    || /already exists|duplicate|resource exists/i.test(String(error?.message || error?.error || ''));
}

function contractConflict() {
  return contractError(409, 'contrato_payload_conflict', 'Ese identificador de contrato ya existe con otros datos.');
}

function mapTransactionError(error) {
  if (Number.isInteger(error?.status) && typeof error?.code === 'string') return error;
  if (error?.code === '23503') return contractError(404, 'sede_no_encontrada', 'Sede no encontrada.');
  if (isUniqueViolation(error)) return contractConflict();
  if (String(error?.code || '').startsWith('08')) {
    return contractError(503, 'contrato_db_unavailable', 'La base de datos del contrato no está disponible.');
  }
  return contractError(500, 'contrato_no_guardado', 'No se pudo guardar el contrato.');
}

// La lectura previa sólo evita resubir un archivo ya guardado: no autoriza
// nada. La transacción de abajo vuelve a decidir con el actor persistido
// bloqueado, incluso en el camino de replay.
async function readContract(pgPool, contratoUUID) {
  try {
    const { rows } = await pgPool.query('select * from public.contratos_sedes where id = $1', [contratoUUID]);
    return rows[0] || null;
  } catch {
    throw contractError(503, 'contrato_consulta_fallida', 'No se pudo verificar el contrato.');
  }
}

// La capacidad de archivo se detecta contra el catálogo real: en QA hay 7
// columnas y el metadata-only debe seguir funcionando. storage_path se agrega
// recién con el candidato aplicado y sólo entonces se permite un archivo.
async function storageColumnAvailable(pgPool) {
  try {
    const { rows } = await pgPool.query(
      `select 1 as present
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'contratos_sedes'
          and column_name = $1
        limit 1`,
      [CONTRACT_STORAGE_COLUMN],
    );
    return rows.length === 1;
  } catch {
    throw contractError(503, 'contrato_consulta_fallida', 'No se pudo verificar la capacidad de archivo del contrato.');
  }
}

function replayResult(row, { file, storagePath }) {
  return {
    status: 200,
    body: contractReceipt(row, { file, storagePath, replayed: true }),
  };
}

// Una sola transacción corta y atómica: bloquea con FOR SHARE todas las filas
// de user_roles del actor persistido, exige exactamente una y que sea
// super_admin, y recién después resuelve replay/insert por la PK. Si una
// revocación ganó la carrera de locks, al retomar el lock (READ COMMITTED
// reevalúa la fila) el rol ya no es super_admin y la transacción no escribe.
// No hay storage dentro de la transacción ni ampliación de roles/grants.
async function persistContractTransaction({
  pgPool,
  actorId,
  sedeId,
  metadata,
  expected,
  storagePath,
  hasStorage,
  file,
}) {
  let client;
  try {
    client = await pgPool.connect();
  } catch {
    throw contractError(503, 'contrato_db_unavailable', 'La base de datos del contrato no está disponible.');
  }
  let committed = false;
  try {
    await client.query('begin');
    const roles = (await client.query(
      'select role from public.user_roles where user_id = $1 for share',
      [actorId],
    )).rows;
    if (roles.length !== 1 || roles[0].role !== 'super_admin') {
      throw contractError(403, 'forbidden', 'El rol actual ya no permite guardar contratos.');
    }
    const sede = await client.query('select 1 from public.sedes where id = $1', [sedeId]);
    if (sede.rowCount !== 1) throw contractError(404, 'sede_no_encontrada', 'Sede no encontrada.');

    const current = await client.query('select * from public.contratos_sedes where id = $1 for update', [metadata.contratoUUID]);
    if (current.rows[0]) {
      if (!sameContract(current.rows[0], expected, hasStorage)) throw contractConflict();
      await client.query('commit');
      committed = true;
      return replayResult(current.rows[0], { file, storagePath });
    }

    const row = {
      id: metadata.contratoUUID,
      sede_id: sedeId,
      fecha_inicio: metadata.fecha_inicio,
      fecha_vencimiento: metadata.fecha_vencimiento,
      referencia: metadata.referencia,
      archivo_url: null,
    };
    const columns = Object.keys(row);
    const values = Object.values(row);
    if (hasStorage) {
      columns.push(CONTRACT_STORAGE_COLUMN);
      values.push(storagePath);
    }
    const inserted = await client.query(
      `insert into public.contratos_sedes (${columns.join(',')})
       values (${values.map((_, index) => `$${index + 1}`).join(',')})
       on conflict (id) do nothing
       returning *`,
      values,
    );
    if (inserted.rows[0]) {
      await client.query('commit');
      committed = true;
      return {
        status: 201,
        body: contractReceipt(inserted.rows[0], { file, storagePath, replayed: false }),
      };
    }

    // Otra transacción insertó el mismo UUID mientras esperábamos la PK: se
    // relee dentro de la misma transacción y se compara el payload completo.
    const raced = await client.query('select * from public.contratos_sedes where id = $1 for update', [metadata.contratoUUID]);
    if (raced.rows[0] && sameContract(raced.rows[0], expected, hasStorage)) {
      await client.query('commit');
      committed = true;
      return replayResult(raced.rows[0], { file, storagePath });
    }
    throw contractConflict();
  } catch (error) {
    throw mapTransactionError(error);
  } finally {
    if (!committed) {
      try { await client.query('rollback'); } catch { /* la conexión ya se descartó */ }
    }
    client.release();
  }
}

// Servicio sin HTTP. El actor sale del token ya resuelto, pero la autoridad que
// decide es la fila persistida de user_roles bloqueada dentro de la
// transacción. Las esperas de storage (upload) quedan fuera de esa transacción
// y sólo después se re-resuelve el actor actual antes de escribir metadata.
export async function saveSedeContract({
  pgPool,
  privateStorage = null,
  actorId,
  sedeId,
  metadata,
  file = null,
  revalidateActor,
} = {}) {
  if (!pgPool || typeof pgPool.query !== 'function' || typeof pgPool.connect !== 'function') {
    throw new Error('pgPool requerido');
  }
  if (!actorId) throw new Error('actorId requerido');
  if (typeof revalidateActor !== 'function') throw new Error('revalidateActor requerido');
  const config = normalizePrivateStorageConfig(privateStorage);
  const storagePath = file
    ? contractStoragePath({
      sedeId,
      contratoUUID: metadata.contratoUUID,
      sha256: file.sha256,
      ext: file.ext,
    })
    : null;
  const expected = {
    sede_id: sedeId,
    fecha_inicio: metadata.fecha_inicio,
    fecha_vencimiento: metadata.fecha_vencimiento,
    referencia: metadata.referencia,
    storage_path: storagePath,
  };
  const hasStorage = await storageColumnAvailable(pgPool);
  const existing = await readContract(pgPool, metadata.contratoUUID);

  let currentActorId = actorId;
  // Un archivo exige adaptador privado y la columna candidata, aun en replay:
  // con el flag OFF el modo archivo queda cerrado de punta a punta.
  if (file) {
    if (!config || typeof config.upload !== 'function') {
      throw contractError(503, 'contrato_storage_unavailable', 'El archivo privado del contrato no está disponible.');
    }
    if (!hasStorage) {
      throw contractError(503, 'contrato_storage_metadata_unavailable', 'La capacidad de archivo privado del contrato no está habilitada.');
    }
  }
  // Si la fila ya existe con otro payload no se sube nada: la transacción
  // devuelve 409. El upload sólo ocurre cuando todavía no hay fila para el UUID.
  if (file && !existing) {
    currentActorId = await revalidateActor();
    const uploaded = await config.upload(storagePath, file.buffer, file.mime);
    if (uploaded?.error && !isStorageDuplicate(uploaded.error)) {
      const raced = await readContract(pgPool, metadata.contratoUUID);
      if (!(raced && sameContract(raced, expected, hasStorage))) {
        throw contractError(502, 'contrato_archivo_no_guardado', 'No se pudo guardar el archivo privado del contrato.');
      }
    }
    // La espera de storage terminó: se vuelve a resolver el actor antes de la
    // transacción corta. El objeto subido no se borra si la autorización cambió.
    currentActorId = await revalidateActor();
  } else {
    currentActorId = await revalidateActor();
  }

  return persistContractTransaction({
    pgPool,
    actorId: currentActorId,
    sedeId,
    metadata,
    expected,
    storagePath,
    hasStorage,
    file,
  });
}

// Read authorization snapshot, repeated after external download. No storage awaits
// under database locks; both snapshots require the current persisted actor.
export async function readContractDownloadSnapshot({ pgPool, actorId, sedeId, contratoUUID, expectedPath }) {
  if (!pgPool?.connect || !pgPool?.query) throw contractError(503, 'contrato_db_unavailable', 'La base del contrato no está disponible.');
  if (!await storageColumnAvailable(pgPool)) throw contractError(503, 'contrato_storage_metadata_unavailable', 'El archivo privado no está habilitado.');
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    const roles = (await client.query('SELECT role FROM public.user_roles WHERE user_id=$1 FOR SHARE', [actorId])).rows;
    if (roles.length !== 1 || roles[0].role !== 'super_admin') throw contractError(403, 'forbidden', 'Tu cuenta no tiene acceso al contrato.');
    const row = (await client.query('SELECT id,sede_id,storage_path FROM public.contratos_sedes WHERE id=$1 FOR SHARE', [contratoUUID])).rows[0];
    if (!row || Number(row.sede_id) !== sedeId || !row.storage_path) throw contractError(404, 'contrato_archivo_no_encontrado', 'Archivo de contrato no encontrado.');
    if (expectedPath !== undefined && row.storage_path !== expectedPath) throw contractError(409, 'contrato_archivo_cambio', 'El contrato cambió. Volvé a solicitarlo.');
    if (!new RegExp(`^${sedeId}/${contratoUUID}/[0-9a-f]{64}\\.(?:pdf|jpg|png|webp)$`).test(row.storage_path)) throw contractError(503, 'contrato_storage_path_invalido', 'El archivo privado no se pudo verificar.');
    await client.query('COMMIT');
    return row.storage_path;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw mapTransactionError(error);
  } finally { client.release(); }
}

export async function downloadSedeContract({ pgPool, privateStorage, actorId, sedeId, contratoUUID, revalidateActor }) {
  const config = normalizePrivateStorageConfig(privateStorage);
  if (!config?.download) throw contractError(503, 'contrato_storage_unavailable', 'El archivo privado no está habilitado.');
  const path = await readContractDownloadSnapshot({ pgPool, actorId, sedeId, contratoUUID });
  let downloaded;
  try { downloaded = await config.download(path); }
  catch (error) { if (error?.status && error?.code) throw error; throw contractError(503, 'contrato_archivo_no_verificado', 'El archivo privado no se pudo descargar.'); }
  let file;
  try { file = validateContractFile({ buffer: downloaded.buffer, mimetype: downloaded.mime }); }
  catch { throw contractError(503, 'contrato_archivo_no_verificado', 'El archivo privado no se pudo verificar.'); }
  if (contractStoragePath({ sedeId, contratoUUID, sha256: file.sha256, ext: file.ext }) !== path) throw contractError(503, 'contrato_archivo_no_verificado', 'El archivo privado no se pudo verificar.');
  const currentActor = await revalidateActor();
  if (currentActor !== actorId) throw contractError(401, 'authentication_required', 'La sesión cambió.');
  await readContractDownloadSnapshot({ pgPool, actorId, sedeId, contratoUUID, expectedPath: path });
  return file;
}
