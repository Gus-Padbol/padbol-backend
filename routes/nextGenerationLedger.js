import express from 'express';
import { requireSuperAdminUser } from '../lib/authAccess.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const TYPES = new Set(['sponsor_cobrado', 'gasto', 'apartar_fondo', 'liberar_fondo', 'reversion']);
const fail = (res, status, error) => res.status(status).json({ error });
function enabled() { return process.env.NEXTGEN_MANUAL_LEDGER_ENABLED === 'true'; }
function errorFor(error) {
  const message = String(error?.message || '');
  if (message.includes('FORBIDDEN')) return [403, 'Solo SuperAdmin puede operar la cuenta'];
  if (message.includes('REQUEST_NOT_FOUND')) return [404, 'Programa inexistente'];
  if (message.includes('REQUEST_NOT_APPROVED') || message.includes('MAPPING_CHANGED')) return [409, 'El programa aprobado o su sede cambió'];
  if (message.includes('IDEMPOTENCY_CONFLICT')) return [409, 'La clave ya existe con otro contenido'];
  if (message.includes('REVERSAL_ALREADY') || message.includes('REVERSAL_INVALID')) return [409, 'Reversión inválida o ya registrada'];
  if (message.includes('NEGATIVE_BALANCE')) return [409, 'El movimiento dejaría un saldo negativo'];
  if (message.includes('INVALID')) return [400, 'Revisá moneda, tipo, importe, clave y reversión'];
  return [503, 'No se pudo registrar la operación'];
}
export function createNextGenerationLedgerRouter(deps) {
  const router = express.Router();
  const authDeps = {
    getAuthenticatedUser: deps.getAuthenticatedUser,
    fetchUserRoleRowForAuthUser: deps.fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails: deps.legacySuperAdminEmails || [],
  };
  const superAdmin = (req, res) => requireSuperAdminUser(req, res, authDeps);
  const call = async (req, res, operationData) => {
    if (!enabled()) return fail(res, 503, 'El ledger manual está deshabilitado');
    const auth = await superAdmin(req, res); if (!auth) return;
    try {
      const { rows } = await deps.pgPool.query(
        'select public.nextgen_ledger_command($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::numeric,$8::uuid) result',
        [auth.user.id, operationData.operation, operationData.venueRequestId, operationData.currency,
          operationData.operationKey || null, operationData.type || null, operationData.amount || null, operationData.originalId || null],
      );
      const result = rows[0]?.result;
      if (!result || typeof result !== 'object') return fail(res, 503, 'No se pudo confirmar la cuenta');
      return res.json(result);
    } catch (error) {
      const [status, message] = errorFor(error);
      return fail(res, status, message);
    }
  };
  router.get('/', async (req, res) => {
    const venueRequestId = String(req.query.venue_request_id || '');
    const currency = String(req.query.currency || '').toUpperCase();
    if (!UUID.test(venueRequestId) || !CURRENCY.test(currency)) return fail(res, 400, 'venue_request_id y currency son obligatorios');
    return call(req, res, { operation: 'read', venueRequestId, currency });
  });
  router.post('/movimientos', async (req, res) => {
    const b = req.body || {};
    const venueRequestId = String(b.venue_request_id || '');
    const currency = String(b.currency || '').toUpperCase();
    const operationKey = typeof b.operation_key === 'string' ? b.operation_key.trim() : '';
    const type = String(b.type || '');
    const amount = typeof b.amount === 'string' ? b.amount.trim() : '';
    const originalId = b.original_id == null ? null : String(b.original_id);
    if (!UUID.test(venueRequestId) || !CURRENCY.test(currency) || !TYPES.has(type)
      || !AMOUNT.test(amount) || Number(amount) <= 0 || !operationKey || operationKey.length > 160
      || (type === 'reversion' ? !UUID.test(originalId || '') : originalId != null)) {
      return fail(res, 400, 'Revisá moneda, tipo, importe, clave y reversión');
    }
    return call(req, res, { operation: 'move', venueRequestId, currency, operationKey, type, amount, originalId });
  });
  return router;
}
