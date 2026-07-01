import { buildControlPath } from './scoreboardControlToken.js';

export function getPublicWebBase() {
  const raw = process.env.PUBLIC_WEB_BASE || process.env.FRONTEND_URL || 'https://padbolmatch.com';
  return String(raw).trim().replace(/\/+$/, '') || 'https://padbolmatch.com';
}

export function buildLiveCanchaDisplayPath(sedeId, cancha) {
  const sid = parseInt(String(sedeId ?? ''), 10);
  const canchaStr = String(cancha ?? '').trim();
  if (!Number.isFinite(sid) || sid <= 0 || !canchaStr) return null;
  return `/live/cancha/${sid}/${encodeURIComponent(canchaStr)}`;
}

export function buildPublicUrl(path) {
  if (path == null || path === '') return null;
  const normalized = String(path).startsWith('/') ? String(path) : `/${path}`;
  return `${getPublicWebBase()}${normalized}`;
}

export function buildDisplayLinks(sedeId, cancha) {
  const display_path = buildLiveCanchaDisplayPath(sedeId, cancha);
  return {
    display_path,
    display_url: buildPublicUrl(display_path),
  };
}

export function buildControlLinks(controlToken) {
  if (controlToken == null || controlToken === '') {
    return {
      control_path: null,
      control_url: null,
    };
  }
  const control_path = buildControlPath(controlToken);
  return {
    control_path,
    control_url: buildPublicUrl(control_path),
  };
}
