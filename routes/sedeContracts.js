import multer from 'multer';
import { strictSuperAdminRole } from '../lib/fipaDocumentLibrary.js';
import {
  CONTRACT_FILE_MAX_BYTES,
  contractError,
  normalizePrivateStorageConfig,
  parseSedeId,
  saveSedeContract,
  validateContractFile,
  validateContractMetadata,
} from '../lib/sedeContracts.js';

// Montado en server.js recién después del freeze 052, junto a
// mountSedesProfileRoutes y antes del fallback 404. Referencia del mount:
//
//   import { mountSedeContractsRoutes } from './routes/sedeContracts.js';
//   mountSedeContractsRoutes(app, {
//     supabaseAdmin,
//     authUserFromBearer,
//     // Habilitar sólo después de aplicar el candidato SQL autorizado:
//     // privateStorage: { bucket: 'contratos-sedes-privados', column: 'storage_path' },
//   });
//
// Sin privateStorage el metadata-only funciona con las 7 columnas reales; un
// archivo privado falla cerrado con 503 antes de escribir metadata.

const contractUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CONTRACT_FILE_MAX_BYTES,
    files: 1,
    fields: 8,
    fieldSize: 4096,
    parts: 12,
  },
});

function runContractUpload(req, res) {
  return new Promise((resolve, reject) => {
    contractUpload.single('archivo')(req, res, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function uploadErrorResponse(error) {
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return { status: 413, body: { ok: false, error: 'El archivo del contrato supera el límite permitido.', code: 'archivo_demasiado_grande' } };
  }
  return { status: 400, body: { ok: false, error: 'No se pudo leer el archivo del contrato.', code: 'archivo_invalido' } };
}

function sendContractError(res, error) {
  const known = Number.isInteger(error?.status) && typeof error?.code === 'string';
  const status = known ? error.status : 500;
  return res.status(status).json({
    ok: false,
    error: known ? error.message : 'No se pudo guardar el contrato.',
    ...(known ? { code: error.code } : {}),
  });
}

export function mountSedeContractsRoutes(app, {
  supabaseAdmin,
  authUserFromBearer,
  privateStorage = null,
  strictRole = strictSuperAdminRole,
} = {}) {
  if (!app || typeof app.post !== 'function') throw new Error('app de Express requerida');
  if (!supabaseAdmin) throw new Error('supabaseAdmin requerido');
  if (typeof authUserFromBearer !== 'function') throw new Error('authUserFromBearer requerido');
  if (typeof strictRole !== 'function') throw new Error('strictRole requerido');
  // Falla al montar si alguien intenta reutilizar un bucket/columna ajenos.
  const storageConfig = normalizePrivateStorageConfig(privateStorage);

  app.post('/api/sedes/:id/contrato', async (req, res) => {
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id) {
        return res.status(401).json({ ok: false, error: 'No autorizado', code: 'authentication_required' });
      }
      if (!await strictRole(supabaseAdmin, user.id)) {
        return res.status(403).json({ ok: false, error: 'Solo super admin puede guardar contratos de sede', code: 'forbidden' });
      }

      try {
        await runContractUpload(req, res);
      } catch (uploadError) {
        const mapped = uploadErrorResponse(uploadError);
        return res.status(mapped.status).json(mapped.body);
      }

      const sedeId = parseSedeId(req.params.id);
      const metadata = validateContractMetadata({ raw: req.body || {}, sedeId });
      const file = validateContractFile(req.file);

      const { data: sede, error: sedeError } = await supabaseAdmin
        .from('sedes')
        .select('id')
        .eq('id', sedeId)
        .maybeSingle();
      if (sedeError) {
        throw contractError(503, 'sede_consulta_fallida', 'No se pudo verificar la sede.');
      }
      if (!sede) {
        return res.status(404).json({ ok: false, error: 'Sede no encontrada', code: 'sede_no_encontrada' });
      }

      const revalidateActor = async () => {
        const current = await authUserFromBearer(req);
        if (!current?.id || current.id !== user.id) {
          throw contractError(401, 'authentication_required', 'La sesión cambió. Volvé a abrir el alta con tu cuenta actual.');
        }
        if (!await strictRole(supabaseAdmin, current.id)) {
          throw contractError(403, 'forbidden', 'El rol actual ya no permite guardar contratos.');
        }
      };

      const result = await saveSedeContract({
        supabaseAdmin,
        privateStorage: storageConfig,
        sedeId,
        metadata,
        file,
        revalidateActor,
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      if (error?.code && error?.status) {
        console.warn('⚠️ POST /api/sedes/:id/contrato:', error.code);
      } else {
        console.error('❌ POST /api/sedes/:id/contrato:', error?.message || 'error');
      }
      return sendContractError(res, error);
    }
  });
}
