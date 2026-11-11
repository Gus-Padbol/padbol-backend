import {createNationsMarkerAuthAdapter} from './nationsMarkerAuthAdapter.js';
import {loadNationsMarkerMatchContext} from './nationsMarkerMatchContext.js';
import {createNationsMarkerDurableRouter} from '../../routes/nationsMarkerDurableHttp.js';
/** Instalador OFF por defecto: usa el pgPool existente y auth ya verificada del server. */
export function registerNationsMarkerDurableRoutes(app, { pgPool, getAuthenticatedUser, fetchUserRoleRowForAuthUser, enabled = false }) {
  if (!enabled || !pgPool || typeof getAuthenticatedUser !== 'function' || typeof fetchUserRoleRowForAuthUser !== 'function') return false;
  const authorize = createNationsMarkerAuthAdapter({ getAuthenticatedUser, fetchUserRoleRowForAuthUser, loadContext: (id) => loadNationsMarkerMatchContext(pgPool, id) });
  const handler = createNationsMarkerDurableRouter({ pool: pgPool, authorize });
  app.use((req, res, next) => {
    if (req.path !== '/api/nations/marker' && !req.path.startsWith('/api/nations/marker/')) return next();
    return handler(req, res);
  });
  return true;
}
