import express from 'express';

/**
 * Gate SOLO para escrituras de Mis diseños (POST /api/admin/content/designs y
 * PUT /api/admin/content/designs/:id). Se monta antes del parser global de
 * 100 KB: los diseños con PNG de hasta 2 MB necesitan un límite propio de 4 MB.
 * Ninguna otra ruta ni método pasa por este parser.
 */
export const CONTENT_DESIGNS_JSON_LIMIT = '4mb';
export const CONTENT_DESIGNS_MOUNT_PATH = '/api/admin/content/designs';

function isDesignsWrite(req) {
  if (req.method !== 'POST' && req.method !== 'PUT') return false;
  const path = String(req.path || '').replace(/\/+$/, '');
  return path === CONTENT_DESIGNS_MOUNT_PATH || path.startsWith(`${CONTENT_DESIGNS_MOUNT_PATH}/`);
}

/**
 * Un rechazo definido del parser (cuerpo mayor a 4 MB) se responde como JSON
 * tipado antes de llegar al router, a la autenticación persistida o a PG.
 * Otros errores del parser conservan el manejo previo de Express.
 */
export function createContentDesignsBodyGate({ limit = CONTENT_DESIGNS_JSON_LIMIT } = {}) {
  const parser = express.json({ limit });
  return function contentDesignsBodyGate(req, res, next) {
    if (!isDesignsWrite(req)) return next();
    parser(req, res, (error) => {
      if (!error) return next();
      if (error.type === 'entity.too.large' || error.status === 413 || error.statusCode === 413) {
        return res.status(413).json({
          error: 'El diseño supera el máximo de 4 MB del servidor. Quitá o reducí los logos y volvé a guardar; el borrador no se guardó.',
          code: 'CONTENT_DESIGN_TOO_LARGE',
        });
      }
      return next(error);
    });
  };
}
