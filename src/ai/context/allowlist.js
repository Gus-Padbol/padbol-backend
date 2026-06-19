import {
  AI_ALLOWED_PARAM_KEYS,
  AI_ALLOWED_SKILLS,
  AI_MESSAGE_MAX_LENGTH,
} from '../constants.js';

const ALLOWED_DEPORTES = new Set(['padbol', 'padel', 'pickleball', 'tenis']);

function parsePositiveInt(value) {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeDeporte(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'pádel' || s === 'padel') return 'padel';
  if (ALLOWED_DEPORTES.has(s)) return s;
  return null;
}

function normalizeScreen(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.length > 64) {
    const err = new Error('params.screen demasiado largo (máximo 64 caracteres)');
    err.status = 400;
    throw err;
  }
  return s;
}

export function sanitizeAllowedParams(rawParams = {}) {
  if (rawParams == null) return {};
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    const err = new Error('params debe ser un objeto');
    err.status = 400;
    throw err;
  }

  const unknownKeys = Object.keys(rawParams).filter((key) => !AI_ALLOWED_PARAM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    const err = new Error(`params contiene campos no permitidos: ${unknownKeys.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const out = {};
  if (rawParams.sede_id != null && rawParams.sede_id !== '') {
    const sedeId = parsePositiveInt(rawParams.sede_id);
    if (sedeId == null) {
      const err = new Error('params.sede_id inválido');
      err.status = 400;
      throw err;
    }
    out.sede_id = sedeId;
  }

  if (rawParams.screen != null && rawParams.screen !== '') {
    out.screen = normalizeScreen(rawParams.screen);
  }

  if (rawParams.deporte != null && rawParams.deporte !== '') {
    const deporte = normalizeDeporte(rawParams.deporte);
    if (!deporte) {
      const err = new Error('params.deporte inválido (padbol, padel, pickleball, tenis)');
      err.status = 400;
      throw err;
    }
    out.deporte = deporte;
  }

  return out;
}

export function validateAiChatRequest(body = {}) {
  if (body != null && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'context')) {
    const err = new Error('context no está permitido; usá params con allowlist');
    err.status = 400;
    err.code = 'AI_CONTEXT_NOT_ALLOWED';
    throw err;
  }

  const skill = String(body?.skill ?? '').trim().toLowerCase();
  if (!skill) {
    const err = new Error('skill es requerido');
    err.status = 400;
    throw err;
  }
  if (!AI_ALLOWED_SKILLS.has(skill)) {
    const err = new Error(`skill no permitido: ${skill}`);
    err.status = 400;
    err.code = 'AI_SKILL_NOT_ALLOWED';
    throw err;
  }

  const message = String(body?.message ?? '').trim();
  if (!message) {
    const err = new Error('message es requerido');
    err.status = 400;
    throw err;
  }
  if (message.length > AI_MESSAGE_MAX_LENGTH) {
    const err = new Error(`message demasiado largo (máximo ${AI_MESSAGE_MAX_LENGTH} caracteres)`);
    err.status = 400;
    throw err;
  }

  const params = sanitizeAllowedParams(body?.params ?? {});

  return { skill, message, params };
}
