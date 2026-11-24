import {
  CONTRACT_PRIVATE_BUCKET,
  CONTRACT_STORAGE_COLUMN,
  contractError,
  CONTRACT_FILE_MAX_BYTES,
} from './sedeContracts.js';

// Flag exacto, apagado por defecto. Sin esta variable en 'true' el mount del
// servidor pasa privateStorage=null y el archivo privado de contrato falla
// cerrado; el metadata-only sigue funcionando con las 7 columnas reales.
export const SEDE_CONTRACT_PRIVATE_STORAGE_FLAG = 'SEDE_CONTRATOS_PRIVATE_STORAGE_ENABLED';

// El path sólo puede ser el derivado determinista de sede+UUID+hash, nunca un
// path arbitrario del cliente. Bucket y columna también son fijos.
const CONTRACT_STORAGE_PATH = /^[1-9][0-9]*\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{64}\.(?:pdf|jpg|png|webp)$/;

// Adaptador concreto del SDK de Supabase ya instalado. No lee credenciales ni
// URLs públicas, no elige otros buckets, nunca borra objetos y no expone
// getPublicUrl/remove. La verificación public=false se hace con el SDK antes
// del primer upload y se cachea sólo si fue exitosa.
export function createSedeContractPrivateStorage({ supabaseAdmin, enabled = false } = {}) {
  if (enabled !== true) return null;
  const storage = supabaseAdmin?.storage;
  if (!storage || typeof storage.getBucket !== 'function' || typeof storage.from !== 'function') {
    throw new Error('El SDK de storage de Supabase es requerido para habilitar el archivo privado de contratos.');
  }

  let privateBucketVerified = false;
  async function assertPrivateBucket(fresh = false) {
    if (privateBucketVerified && !fresh) return;
    let result;
    try {
      result = await storage.getBucket(CONTRACT_PRIVATE_BUCKET);
    } catch {
      throw contractError(503, 'contrato_storage_unavailable', 'No se pudo verificar el bucket privado del contrato.');
    }
    if (result?.error || !result?.data) {
      throw contractError(503, 'contrato_storage_unavailable', 'No se pudo verificar el bucket privado del contrato.');
    }
    if (result.data.public !== false) {
      throw contractError(503, 'contrato_storage_no_privado', 'El bucket de contratos debe ser privado.');
    }
    privateBucketVerified = true;
  }

  return Object.freeze({
    bucket: CONTRACT_PRIVATE_BUCKET,
    column: CONTRACT_STORAGE_COLUMN,
    async download(path) {
      if (typeof path !== 'string' || !CONTRACT_STORAGE_PATH.test(path)) throw contractError(503, 'contrato_storage_path_invalido', 'El archivo privado no se pudo verificar.');
      await assertPrivateBucket(true);
      const result = await storage.from(CONTRACT_PRIVATE_BUCKET).download(path);
      const blob = result?.data;
      if (result?.error || !blob || !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > CONTRACT_FILE_MAX_BYTES || typeof blob.arrayBuffer !== 'function') throw contractError(503, 'contrato_archivo_no_verificado', 'El archivo privado no se pudo verificar.');
      const buffer = Buffer.from(await blob.arrayBuffer());
      if (buffer.length !== blob.size) throw contractError(503, 'contrato_archivo_no_verificado', 'El archivo privado no se pudo verificar.');
      return { buffer, mime: blob.type };
    },
    async upload(path, buffer, contentType) {
      if (typeof path !== 'string' || !CONTRACT_STORAGE_PATH.test(path)) {
        throw contractError(500, 'contrato_storage_path_invalido', 'El path privado del contrato es inválido.');
      }
      await assertPrivateBucket();
      const { error } = await storage
        .from(CONTRACT_PRIVATE_BUCKET)
        .upload(path, buffer, { contentType, upsert: false });
      return { error: error || null };
    },
  });
}
