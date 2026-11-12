import {createNationsMarkerAuthAdapter} from './nationsMarkerAuthAdapter.js';
import {loadNationsMarkerMatchContext} from './nationsMarkerMatchContext.js';
import {createNationsMarkerDurableRouter} from '../../routes/nationsMarkerDurableHttp.js';
import {createNationsMarkerControlTokenRouter} from '../../routes/nationsMarkerControlToken.js';
import {scoreboardControlWriteRateLimit} from '../rateLimit.js';
/** Instalador OFF por defecto: usa el pgPool existente y auth ya verificada del server. */
export function registerNationsMarkerDurableRoutes(app, { pgPool, getAuthenticatedUser, fetchUserRoleRowForAuthUser, enabled = false, onCommitted=null }) {
  if (!enabled || !pgPool || typeof getAuthenticatedUser !== 'function' || typeof fetchUserRoleRowForAuthUser !== 'function') return false;
  const authorize = createNationsMarkerAuthAdapter({ getAuthenticatedUser, fetchUserRoleRowForAuthUser, loadContext: (id) => loadNationsMarkerMatchContext(pgPool, id) });
  const handler = createNationsMarkerDurableRouter({ pool: pgPool, authorize, onCommitted });
  app.use((req, res, next) => {
    if (req.path !== '/api/nations/marker' && !req.path.startsWith('/api/nations/marker/')) return next();
    return handler(req, res);
  });
  const controlHandler=createNationsMarkerControlTokenRouter({pool:pgPool,onCommitted});
  app.use((req,res,next)=>{
    if(!/^\/api\/scoreboard\/control\/[^/]+\/nations(?:\/|$)/.test(req.path))return next();
    if(req.method==='POST')return scoreboardControlWriteRateLimit(req,res,()=>controlHandler(req,res));
    return controlHandler(req,res);
  });
  return true;
}
