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

export function replayOnCanonicalRoute(_app, req, res, _next, canonicalPath) {
  const originalUrl = req.url;
  const query = originalUrl.includes('?') ? originalUrl.slice(originalUrl.indexOf('?')) : '';
  // A same-origin 307 keeps the GET method and Authorization header while
  // avoiding Express' cached parsed URL. Re-entering app.handle() after
  // mutating req.url can match the legacy route again and recurse to a 500.
  return res.redirect(307, `${canonicalPath}${query}`);
}

export function mountAdminLegacyAliases(app) {
  for (const [legacyPath, canonicalPath] of Object.entries(ADMIN_LEGACY_GET_ALIASES)) {
    app.get(legacyPath, (req, res, next) => replayOnCanonicalRoute(app, req, res, next, canonicalPath));
  }
}
