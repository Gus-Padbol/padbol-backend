const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|api[_-]?key|access[_-]?token|mp_|stripe_|webhook|credit|cvv|qr_token|push_token|expo_push/i;

export function maskEmail(email) {
  const s = String(email ?? '').trim();
  if (!s) return '';
  if (!s.includes('@')) return '(email)';
  const [local, domain] = s.split('@');
  if (!local || !domain) return '(email)';
  const maskedLocal = local.length <= 2
    ? '*'.repeat(Math.max(local.length, 1))
    : `${local.slice(0, 1)}***${local.slice(-1)}`;
  return `${maskedLocal}@${domain}`;
}

export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 4) return '(phone)';
  return `***${digits.slice(-4)}`;
}

export function envConfigured(envName) {
  const value = String(process.env[envName] ?? '').trim();
  return value ? 'configured' : 'not set';
}

export function safeQueryLog(query = {}) {
  const out = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    const lk = String(key).toLowerCase();
    if (SENSITIVE_KEY_PATTERN.test(lk)) {
      out[key] = value != null ? '(redacted)' : value;
    } else if (/email/.test(lk)) {
      out[key] = maskEmail(value);
    } else if (/phone|whatsapp|telefono|mobile/.test(lk)) {
      out[key] = maskPhone(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function summarizeError(err) {
  if (!err) return { message: 'unknown error' };
  return {
    message: err?.message ?? String(err),
    code: err?.code ?? undefined,
    status: err?.status ?? undefined,
  };
}

export function redactObject(value, depth = 0) {
  if (value == null || depth > 5) return value;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = raw != null ? '(redacted)' : raw;
    } else if (/email/i.test(key)) {
      out[key] = maskEmail(raw);
    } else if (/phone|whatsapp|telefono|mobile/i.test(key)) {
      out[key] = maskPhone(raw);
    } else if (typeof raw === 'object' && raw !== null) {
      out[key] = redactObject(raw, depth + 1);
    } else {
      out[key] = raw;
    }
  }
  return out;
}
