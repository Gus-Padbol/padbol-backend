// Guard HTTP reutilizable: usa la autorización real (requireAdminUser +
// resolveTorneoAdminAccess) y datos de torneo inyectados. No es un stub.
import { requireAdminUser } from './authAccess.js';
import { resolveTorneoAdminAccess } from './torneos/torneoAdminAccessService.js';

export function createRequireTorneoAdminByTorneoId({
  adminDeps, fetchTorneoScopeById, resolveAccess = resolveTorneoAdminAccess,
  sendForbidden = (res, auth, reason) => {
    if (auth?.role?.rol === 'admin_club' && reason === 'sede_no_coincide') {
      return res.status(403).json({ error: 'No tenés permiso para operar torneos de otra sede' });
    }
    return res.status(403).json({ error: 'No tenés permiso para esta operación' });
  },
} = {}) {
  if (typeof fetchTorneoScopeById !== 'function') throw new Error('TORNEO_GUARD_CONFIG_INVALID');
  return async function requireTorneoAdminByTorneoId(req, res, torneoId) {
    const auth = await requireAdminUser(req, res, adminDeps);
    if (!auth) return null;
    const { exists, sedeId } = await fetchTorneoScopeById(torneoId);
    if (!exists) { res.status(404).json({ error: 'Torneo no encontrado' }); return null; }
    const { allowed, reason } = resolveAccess(auth, sedeId);
    if (allowed) return auth;
    sendForbidden(res, auth, reason);
    return null;
  };
}
