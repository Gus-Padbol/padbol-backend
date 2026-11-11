import express from 'express';
/**
 * Gate SOLO para POST /api/usuarios/foto-perfil (slash final tolerado).
 * Orden: límite por IP -> auth -> límite por usuario estable -> parser 8mb.
 * No se monta para otros métodos/rutas.
 */
export function createProfilePhotoGate({ authenticate, ipLimit, userLimit, limit = '8mb' }) {
  const parser = express.json({ limit });
  return function profilePhotoGate(req, res, next) {
    if (req.method !== 'POST') return next();
    const path = String(req.path || '').replace(/\/+$/, '');
    if (path !== '/api/usuarios/foto-perfil') return next();
    return ipLimit(req, res, () => {
      Promise.resolve(authenticate(req)).then(({ user, status = 401, error = 'No autorizado' }) => {
        if (!user) return res.status(status).json({ error, code: 'UNAUTHORIZED' });
        req.profilePhotoUser = user;
        return userLimit(req, res, () => parser(req, res, next));
      }).catch(next);
    });
  };
}
