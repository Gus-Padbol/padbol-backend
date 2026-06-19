import { summarizeError } from './safeLog.js';

export const INTERNAL_SERVER_ERROR_MESSAGE = 'Error interno del servidor';

const INTERNAL_LEAK_PATTERN = /column|constraint|relation|postgres|supabase|violates|duplicate key|syntax error|pg_|pgrst|42p01|23505|23503|sql state|stack trace|unexpected token/i;

export function isProductionEnv() {
  return String(process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

export function resolveHttpStatus(err, fallback = 500) {
  const status = Number(err?.status ?? err?.statusCode ?? fallback);
  if (Number.isFinite(status) && status >= 400 && status < 600) return status;
  return fallback;
}

export function sanitizeClientErrorMessage(err, statusCode = 500, fallbackMessage) {
  const status = resolveHttpStatus(err, statusCode);

  if (status >= 500 && isProductionEnv()) {
    return INTERNAL_SERVER_ERROR_MESSAGE;
  }

  const message = String(err?.message ?? err ?? '').trim();
  if (!message) {
    return fallbackMessage || (status >= 500 ? INTERNAL_SERVER_ERROR_MESSAGE : 'Solicitud inválida');
  }

  if (isProductionEnv() && INTERNAL_LEAK_PATTERN.test(message)) {
    return status >= 500 ? INTERNAL_SERVER_ERROR_MESSAGE : 'Solicitud inválida';
  }

  return message;
}

export function buildClientErrorPayload(err, statusCode = 500, fallbackMessage) {
  const status = resolveHttpStatus(err, statusCode);
  return {
    status,
    body: {
      ok: false,
      error: sanitizeClientErrorMessage(err, status, fallbackMessage),
    },
  };
}

export function logServerError(context, err) {
  console.error(`❌ ${context}:`, summarizeError(err));
}

export function sendHttpError(res, err, { statusCode = 500, context, fallbackMessage } = {}) {
  if (context) logServerError(context, err);
  const { status, body } = buildClientErrorPayload(err, statusCode, fallbackMessage);
  return res.status(status).json(body);
}
