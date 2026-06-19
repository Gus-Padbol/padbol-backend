import helmet from 'helmet';
import { isProductionEnv } from './httpErrors.js';

/** Security headers tuned for JSON API (no aggressive CSP). */
export function applySecurityHeaders(app) {
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    hsts: isProductionEnv()
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
  }));
}
