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
  return { bucket, column };
}

export function isoDateFromRow(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text;
}

function comparableContract(row, column) {
  return {
    sede_id: Number(row?.sede_id),
    fecha_inicio: isoDateFromRow(row?.fecha_inicio),
    fecha_vencimiento: isoDateFromRow(row?.fecha_vencimiento),
    referencia: row?.referencia ?? null,
    storage_path: row?.[column] ?? null,
  };
}

function sameContract(row, expected, column) {
  const actual = comparableContract(row, column);
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

function isUndefinedColumn(error) {
  return error?.code === '42703'
    || error?.code === 'PGRST204'
    || /column .* does not exist|could not find the '.*' column|schema cache/i.test(String(error?.message || ''));
}

function isStorageDuplicate(error) {
  return String(error?.statusCode || error?.status || '') === '409'
    || /already exists|duplicate|resource exists/i.test(String(error?.message || error?.error || ''));
}

async function findContractById(supabaseAdmin, contratoUUID) {
  const { data, error } = await supabaseAdmin
    .from('contratos_sedes')
    .select('*')
    .eq('id', contratoUUID)
    .maybeSingle();
  if (error) {
    throw contractError(503, 'contrato_consulta_fallida', 'No se pudo verificar el contrato.');
  }
  return data || null;
}

async function storageColumnAvailable(supabaseAdmin, column) {
  const { error } = await supabaseAdmin
    .from('contratos_sedes')
    .select(column)
    .limit(1);
  if (!error) return true;
  if (isUndefinedColumn(error)) return false;
  throw contractError(503, 'contrato_consulta_fallida', 'No se pudo verificar la capacidad de archivo del contrato.');
}

// Servicio sin HTTP: recibe el actor ya resuelto y un callback que vuelve a
// comprobar el rol persistido. Las esperas de storage quedan fuera de cualquier
// transacción/bloqueo de base.
export async function saveSedeContract({
  supabaseAdmin,
  privateStorage = null,
  sedeId,
  metadata,
  file = null,
  revalidateActor,
} = {}) {
  if (!supabaseAdmin) throw new Error('supabaseAdmin requerido');
  if (typeof revalidateActor !== 'function') throw new Error('revalidateActor requerido');
  const config = normalizePrivateStorageConfig(privateStorage);
  const storageColumn = config?.column || CONTRACT_STORAGE_COLUMN;
  const expectedStoragePath = file
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
    storage_path: expectedStoragePath,
  };

  const existing = await findContractById(supabaseAdmin, metadata.contratoUUID);
  if (existing) {
    if (!sameContract(existing, expected, storageColumn)) {
      throw contractError(409, 'contrato_payload_conflict', 'Ese identificador de contrato ya existe con otros datos.');
    }
    return {
      status: 200,
      body: contractReceipt(existing, {
        file,
        storagePath: expectedStoragePath,
        replayed: true,
      }),
    };
  }

  if (file) {
    if (!config) {
      throw contractError(503, 'contrato_storage_unavailable', 'El archivo privado del contrato no está disponible.');
    }
    if (!await storageColumnAvailable(supabaseAdmin, config.column)) {
      throw contractError(503, 'contrato_storage_metadata_unavailable', 'La capacidad de archivo privado del contrato no está habilitada.');
    }
    await revalidateActor();
    const uploaded = await supabaseAdmin.storage
      .from(config.bucket)
      .upload(expectedStoragePath, file.buffer, { contentType: file.mime, upsert: false });
    if (uploaded?.error && !isStorageDuplicate(uploaded.error)) {
      const raced = await findContractById(supabaseAdmin, metadata.contratoUUID);
      if (raced && sameContract(raced, expected, storageColumn)) {
        return {
          status: 200,
          body: contractReceipt(raced, { file, storagePath: expectedStoragePath, replayed: true }),
        };
      }
      throw contractError(502, 'contrato_archivo_no_guardado', 'No se pudo guardar el archivo privado del contrato.');
    }
    // El rol puede haber sido revocado mientras se esperaba al storage. En ese
    // caso no se escribe metadata; el objeto no se borra automáticamente.
    await revalidateActor();
  } else {
    await revalidateActor();
  }

  const row = {
    id: metadata.contratoUUID,
    sede_id: sedeId,
    fecha_inicio: metadata.fecha_inicio,
    fecha_vencimiento: metadata.fecha_vencimiento,
    referencia: metadata.referencia,
    archivo_url: null,
  };
  if (expectedStoragePath) row[storageColumn] = expectedStoragePath;

  const { data: inserted, error } = await supabaseAdmin
    .from('contratos_sedes')
    .insert(row)
    .select('*')
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findContractById(supabaseAdmin, metadata.contratoUUID);
      if (raced && sameContract(raced, expected, storageColumn)) {
        return {
          status: 200,
          body: contractReceipt(raced, { file, storagePath: expectedStoragePath, replayed: true }),
        };
      }
      throw contractError(409, 'contrato_payload_conflict', 'Ese identificador de contrato ya existe con otros datos.');
    }
    if (isUndefinedColumn(error)) {
      throw contractError(503, 'contrato_storage_metadata_unavailable', 'La capacidad de archivo privado del contrato no está habilitada.');
    }
    throw contractError(500, 'contrato_no_guardado', 'No se pudo guardar el contrato.');
  }

  return {
    status: 201,
    body: contractReceipt(inserted || row, { file, storagePath: expectedStoragePath, replayed: false }),
  };
}
