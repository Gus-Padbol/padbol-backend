/**
 * Compatibilidad temporal con clientes del panel que todavía consumen rutas
 * administrativas sin el prefijo /admin. La petición se vuelve a ejecutar
 * contra la ruta canónica, por lo que conserva exactamente auth, scope y DTO.
 */
export const ADMIN_LEGACY_GET_ALIASES = Object.freeze({
  '/api/analytics-globales': '/api/admin/analytics-globales',
  '/api/sedes-pendientes': '/api/admin/sedes-pendientes',
  '/api/organizaciones': '/api/admin/organizaciones',
  '/api/incentivos': '/api/admin/incentivos',
  '/api/invitaciones-admin': '/api/admin/invitaciones-admin',
  '/api/crm/permissions': '/api/admin/crm/permissions',
  '/api/torneos/resumen-stats': '/api/admin/torneos/resumen-stats',
});

export function replayOnCanonicalRoute(app, req, res, next, canonicalPath) {
  const originalUrl = req.url;
  const query = originalUrl.includes('?') ? originalUrl.slice(originalUrl.indexOf('?')) : '';
  req.url = `${canonicalPath}${query}`;
  app.handle(req, res, (error) => {
    req.url = originalUrl;
    if (error) return next(error);
    if (!res.headersSent) return next();
  });
}

export function mountAdminLegacyAliases(app) {
  for (const [legacyPath, canonicalPath] of Object.entries(ADMIN_LEGACY_GET_ALIASES)) {
    app.get(legacyPath, (req, res, next) => replayOnCanonicalRoute(app, req, res, next, canonicalPath));
  }
}
