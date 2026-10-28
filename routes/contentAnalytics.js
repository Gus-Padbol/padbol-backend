import express from 'express';
import {createContentAnalytics} from '../lib/contentAnalytics.js';

const errors = {
  FORBIDDEN: 'Los informes corresponden a dirección y coordinación.',
  GA4_READ_CONNECTION_NOT_CONFIGURED: 'Falta autorizar la lectura de Google Analytics para mostrar sus informes.',
  GA4_READ_AUTHORIZATION_FAILED: 'Google no permitió consultar la propiedad de Padbol. Revisa la autorización de lectura.',
  GA4_INVALID_DATE: 'Selecciona fechas válidas, hasta ayer y con un máximo de 92 días.',
  GA4_PARTIAL_DAY_NOT_ALLOWED: 'El período incluye un día que todavía no terminó en la zona horaria de Analytics.',
};
export function createContentAnalyticsRouter(deps) {
  const router = express.Router(); let service;
  router.use((req, res, next) => {
    if (!req.workspaceAuth?.canDecidePromotion) return res.status(403).json({error: errors.FORBIDDEN, code: 'FORBIDDEN'});
    if (!deps.pgPool) return res.status(503).json({error: 'Los informes no están disponibles temporalmente.', code: 'GA4_DATABASE_UNAVAILABLE'});
    service ??= createContentAnalytics({pool: deps.pgPool, env: deps.env || process.env, fetchImpl: deps.analyticsFetchImpl, now: deps.analyticsNow});
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  const handle = method => async (req, res) => {
    try { res.json(await service[method](req.workspaceAuth.user.id, req.query)); }
    catch (error) { res.status(error.status || 503).json({error: errors[error.code] || 'No se pudieron consultar los informes de Google Analytics.', code: Object.hasOwn(errors, error.code) ? error.code : 'GA4_READ_UNAVAILABLE'}); }
  };
  router.get('/status', handle('status'));
  router.get('/summary', handle('summary'));
  return router;
}
