function readEnvInt(name, fallback) {
  const parsed = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isRateLimitDisabled() {
  const value = String(process.env.RATE_LIMIT_DISABLED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function maskIp(ip) {
  const s = String(ip ?? '').trim();
  if (!s || s === 'unknown') return '(unknown)';
  if (s.includes(':')) {
    const parts = s.split(':').filter(Boolean);
    return parts.length ? `${parts[0]}:***` : '(ipv6)';
  }
  const octets = s.split('.');
  if (octets.length === 4) return `${octets[0]}.${octets[1]}.***.${octets[3]}`;
  return '***';
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = String(forwarded).split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function authKeySuffix(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return '';
  const token = auth.slice(7).trim();
  if (!token) return '';
  return `:auth${token.length}:${token.slice(-6)}`;
}

function requestPath(req) {
  return String(req.originalUrl || req.url || req.path || '').split('?')[0];
}

export function createRateLimiter({
  name,
  windowMs,
  max,
  windowMsEnv,
  maxEnv,
  windowMsDefault,
  maxDefault,
  keyGenerator,
  message = 'Demasiadas solicitudes. Intentá de nuevo en unos minutos.',
}) {
  const windowMsResolved = windowMs ?? readEnvInt(windowMsEnv, windowMsDefault);
  const maxResolved = max ?? readEnvInt(maxEnv, maxDefault);
  const store = new Map();
  let opsSinceSweep = 0;

  function sweep(now) {
    opsSinceSweep = 0;
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    if (isRateLimitDisabled()) return next();

    const now = Date.now();
    opsSinceSweep += 1;
    if (opsSinceSweep >= 500) sweep(now);

    const key = keyGenerator ? keyGenerator(req) : clientIp(req);
    let entry = store.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMsResolved };
      store.set(key, entry);
    }

    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(maxResolved));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxResolved - entry.count)));

    if (entry.count > maxResolved) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      console.warn('[rate-limit]', {
        limiter: name,
        method: req.method,
        path: requestPath(req),
        ip: maskIp(clientIp(req)),
        retryAfterSeconds,
      });
      return res.status(429).json({
        error: message,
        retryAfterSeconds,
      });
    }

    return next();
  };
}

/** Chivi / IA — más estricto (IP + token JWT si está presente). */
export const chiviRateLimit = createRateLimiter({
  name: 'chivi',
  windowMsEnv: 'RATE_LIMIT_CHIVI_WINDOW_MS',
  maxEnv: 'RATE_LIMIT_CHIVI_MAX',
  windowMsDefault: 10 * 60 * 1000,
  maxDefault: 15,
  keyGenerator: (req) => `${clientIp(req)}${authKeySuffix(req)}`,
  message: 'Demasiadas consultas a Chivi. Esperá unos minutos e intentá de nuevo.',
});

/** Checkout MP / Stripe — moderado por IP. */
export const paymentsRateLimit = createRateLimiter({
  name: 'payments',
  windowMsEnv: 'RATE_LIMIT_PAYMENTS_WINDOW_MS',
  maxEnv: 'RATE_LIMIT_PAYMENTS_MAX',
  windowMsDefault: 15 * 60 * 1000,
  maxDefault: 25,
  message: 'Demasiados intentos de pago. Esperá unos minutos e intentá de nuevo.',
});

/** Crear / modificar / cancelar reservas — moderado por IP + auth si hay JWT. */
export const reservasWriteRateLimit = createRateLimiter({
  name: 'reservas-write',
  windowMsEnv: 'RATE_LIMIT_RESERVAS_WINDOW_MS',
  maxEnv: 'RATE_LIMIT_RESERVAS_MAX',
  windowMsDefault: 15 * 60 * 1000,
  maxDefault: 40,
  keyGenerator: (req) => `${clientIp(req)}${authKeySuffix(req)}`,
  message: 'Demasiadas operaciones de reserva. Esperá unos minutos e intentá de nuevo.',
});

/** Admin push broadcast — moderado por IP. */
export const pushSendRateLimit = createRateLimiter({
  name: 'push-send',
  windowMsEnv: 'RATE_LIMIT_PUSH_SEND_WINDOW_MS',
  maxEnv: 'RATE_LIMIT_PUSH_SEND_MAX',
  windowMsDefault: 15 * 60 * 1000,
  maxDefault: 15,
  message: 'Demasiados envíos push. Esperá unos minutos e intentá de nuevo.',
});

/** Registro de tokens push — moderado por IP + auth. */
export const pushTokensRateLimit = createRateLimiter({
  name: 'push-tokens',
  windowMsEnv: 'RATE_LIMIT_PUSH_TOKENS_WINDOW_MS',
  maxEnv: 'RATE_LIMIT_PUSH_TOKENS_MAX',
  windowMsDefault: 15 * 60 * 1000,
  maxDefault: 30,
  keyGenerator: (req) => `${clientIp(req)}${authKeySuffix(req)}`,
  message: 'Demasiados registros de push token. Esperá unos minutos e intentá de nuevo.',
});

export function configureRateLimitTrustProxy(app) {
  if (String(process.env.RATE_LIMIT_TRUST_PROXY ?? 'true').trim().toLowerCase() !== 'false') {
    app.set('trust proxy', 1);
  }
}
