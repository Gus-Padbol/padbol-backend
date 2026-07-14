/**
 * MEJ-07 Fase 1: deporte personalizado en canchas (`deporte = "custom"`).
 * Identificador técnico fijo; el nombre libre vive en deporte_personalizado.
 * No ampliar whitelists de torneos/ranking/marcador con este módulo.
 */

export const DEPORTE_CUSTOM = 'custom';

export const CANCHA_DEPORTE_OFICIALES = Object.freeze([
  'padbol',
  'padel',
  'pickleball',
  'squash',
  'tenis',
  'futbol_5',
  'futbol_7',
]);

/** Whitelist CRUD canchas (oficiales + custom). No usar en torneos. */
export const CANCHA_DEPORTE_CRUD_VALID = new Set([
  ...CANCHA_DEPORTE_OFICIALES,
  DEPORTE_CUSTOM,
]);

export const MODALIDAD_CUSTOM_VALID = new Set(['individual', 'parejas', 'equipos']);

export const DEPORTE_OFICIAL_LABELS = Object.freeze({
  padbol: 'Padbol',
  padel: 'Pádel',
  pickleball: 'Pickleball',
  squash: 'Squash',
  tenis: 'Tenis',
  futbol_5: 'Fútbol 5',
  futbol_7: 'Fútbol 7',
});

export const CANCHA_CUSTOM_COLUMNS = Object.freeze([
  'deporte_personalizado',
  'cantidad_jugadores',
  'modalidad_custom',
  'duracion_sugerida_min',
  'observacion_custom',
]);

const NOMBRE_CANCHA_MAX = 120;
const DEPORTE_PERSONALIZADO_MAX = 80;
const OBSERVACION_MAX = 500;

export function isMissingCanchaCustomColumnError(err) {
  if (!err) return false;
  const code = String(err.code ?? '');
  if (code === '42703' || code === 'PGRST204') {
    const text = [err.message, err.details, err.hint].filter(Boolean).join(' ').toLowerCase();
    return CANCHA_CUSTOM_COLUMNS.some((col) => text.includes(col));
  }
  const text = String(err.message ?? '').toLowerCase();
  return (
    text.includes('does not exist')
    && CANCHA_CUSTOM_COLUMNS.some((col) => text.includes(col))
  );
}

export function normalizeCanchaDeporteSlug(raw, { emptyDefault = 'padbol' } = {}) {
  const s0 = String(raw ?? '').trim().toLowerCase();
  if (!s0) return emptyDefault;
  if (s0 === 'futbol5') return 'futbol_5';
  if (s0 === 'futbol7') return 'futbol_7';
  if (s0 === 'pádel') return 'padel';
  return s0;
}

/**
 * Normaliza deporte para columna canchas.deporte en CRUD.
 * - vacío → padbol (compat alta sin deporte)
 * - custom → "custom" (nunca remap a padbol)
 * - oficial → slug
 * - desconocido → null (caller → 400)
 */
export function normalizeCanchaDeporteColumnaBody(raw) {
  const s = normalizeCanchaDeporteSlug(raw, { emptyDefault: 'padbol' });
  if (!CANCHA_DEPORTE_CRUD_VALID.has(s)) return null;
  return s;
}

function trimOrNull(raw, maxLen) {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  return t.slice(0, maxLen);
}

function parseOptionalIntInRange(raw, { min, max, field }) {
  if (raw == null || raw === '') return { ok: true, value: null };
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || String(n) !== String(parseInt(String(raw).trim(), 10))) {
    return { ok: false, error: `${field} debe ser un entero` };
  }
  if (n < min || n > max) {
    return { ok: false, error: `${field} debe estar entre ${min} y ${max}` };
  }
  return { ok: true, value: n };
}

function emptyCustomMetadata() {
  return {
    deporte_personalizado: null,
    cantidad_jugadores: null,
    modalidad_custom: null,
    duracion_sugerida_min: null,
    observacion_custom: null,
  };
}

/**
 * Valida y arma payload de deporte + metadatos custom para POST/PATCH canchas.
 * @param {object} body
 * @param {{ mode?: 'create'|'patch', existing?: object }} opts
 * @returns {{ ok: true, patch: object } | { ok: false, status: number, error: string }}
 */
export function buildCanchaDeporteWritePatch(body = {}, { mode = 'create', existing = null } = {}) {
  const hop = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const patch = {};

  let deporte;
  if (mode === 'create' || hop('deporte')) {
    deporte = normalizeCanchaDeporteColumnaBody(body.deporte);
    if (deporte == null) {
      return { ok: false, status: 400, error: 'deporte inválido' };
    }
    patch.deporte = deporte;
  } else {
    deporte = normalizeCanchaDeporteSlug(existing?.deporte, { emptyDefault: 'padbol' });
    if (!CANCHA_DEPORTE_CRUD_VALID.has(deporte)) {
      deporte = 'padbol';
    }
  }

  const customKeysPresent = CANCHA_CUSTOM_COLUMNS.some((k) => hop(k));

  if (deporte !== DEPORTE_CUSTOM) {
    // Oficiales: no enviar columnas custom en altas limpias (compat pre-migración).
    // Limpiar metadatos solo al cambiar desde custom o si el body los manda.
    const shouldClearCustom =
      customKeysPresent
      || (mode === 'patch' && hop('deporte'))
      || (mode === 'patch'
        && normalizeCanchaDeporteSlug(existing?.deporte, { emptyDefault: 'padbol' }) === DEPORTE_CUSTOM);
    if (shouldClearCustom) {
      Object.assign(patch, emptyCustomMetadata());
    }
    return { ok: true, patch };
  }

  // —— custom ——
  const source = {
    deporte_personalizado: hop('deporte_personalizado')
      ? body.deporte_personalizado
      : existing?.deporte_personalizado,
    cantidad_jugadores: hop('cantidad_jugadores')
      ? body.cantidad_jugadores
      : existing?.cantidad_jugadores,
    modalidad_custom: hop('modalidad_custom')
      ? body.modalidad_custom
      : existing?.modalidad_custom,
    duracion_sugerida_min: hop('duracion_sugerida_min')
      ? body.duracion_sugerida_min
      : existing?.duracion_sugerida_min,
    observacion_custom: hop('observacion_custom')
      ? body.observacion_custom
      : existing?.observacion_custom,
  };

  // En create custom, o al pasar a custom, exigir campos en el body (no heredar vacíos).
  const switchingToCustom = hop('deporte') && deporte === DEPORTE_CUSTOM;
  const requireBody = mode === 'create' || switchingToCustom;

  const nombrePers = trimOrNull(
    requireBody && !hop('deporte_personalizado') ? null : source.deporte_personalizado,
    DEPORTE_PERSONALIZADO_MAX,
  );
  if (!nombrePers) {
    return { ok: false, status: 400, error: 'deporte_personalizado es obligatorio cuando deporte = custom' };
  }

  const cantidadRaw = requireBody && !hop('cantidad_jugadores') ? undefined : source.cantidad_jugadores;
  if (cantidadRaw == null || cantidadRaw === '') {
    return { ok: false, status: 400, error: 'cantidad_jugadores es obligatoria cuando deporte = custom' };
  }
  const cantidad = parseOptionalIntInRange(cantidadRaw, {
    min: 1,
    max: 40,
    field: 'cantidad_jugadores',
  });
  if (!cantidad.ok) return { ok: false, status: 400, error: cantidad.error };
  if (cantidad.value == null) {
    return { ok: false, status: 400, error: 'cantidad_jugadores es obligatoria cuando deporte = custom' };
  }

  const modalidadRaw = String(
    requireBody && !hop('modalidad_custom') ? '' : (source.modalidad_custom ?? ''),
  ).trim().toLowerCase();
  if (!modalidadRaw) {
    return { ok: false, status: 400, error: 'modalidad_custom es obligatoria cuando deporte = custom' };
  }
  if (!MODALIDAD_CUSTOM_VALID.has(modalidadRaw)) {
    return {
      ok: false,
      status: 400,
      error: "modalidad_custom inválida (usar 'individual', 'parejas' o 'equipos')",
    };
  }

  const duracion = parseOptionalIntInRange(
    requireBody && !hop('duracion_sugerida_min') ? null : source.duracion_sugerida_min,
    { min: 15, max: 240, field: 'duracion_sugerida_min' },
  );
  if (!duracion.ok) return { ok: false, status: 400, error: duracion.error };

  const observacion = trimOrNull(
    requireBody && !hop('observacion_custom') ? null : source.observacion_custom,
    OBSERVACION_MAX,
  );

  patch.deporte = DEPORTE_CUSTOM;
  patch.deporte_personalizado = nombrePers;
  patch.cantidad_jugadores = cantidad.value;
  patch.modalidad_custom = modalidadRaw;
  patch.duracion_sugerida_min = duracion.value;
  patch.observacion_custom = observacion;

  return { ok: true, patch };
}

export function validateCanchaNombreVisible(raw, { required = true } = {}) {
  const nombre = String(raw ?? '').trim();
  if (!nombre) {
    if (required) return { ok: false, status: 400, error: 'El nombre es obligatorio' };
    return { ok: false, status: 400, error: 'El nombre no puede quedar vacío' };
  }
  if (nombre.length > NOMBRE_CANCHA_MAX) {
    return {
      ok: false,
      status: 400,
      error: `El nombre no puede superar ${NOMBRE_CANCHA_MAX} caracteres`,
    };
  }
  return { ok: true, nombre };
}

export function resolveDeporteLabel(row) {
  const deporte = normalizeCanchaDeporteSlug(row?.deporte, { emptyDefault: 'padbol' });
  if (deporte === DEPORTE_CUSTOM) {
    const custom = trimOrNull(row?.deporte_personalizado, DEPORTE_PERSONALIZADO_MAX);
    return custom || 'Deporte personalizado';
  }
  return DEPORTE_OFICIAL_LABELS[deporte] || deporte;
}

export function mapCanchaPublicDto(row, { orden = null } = {}) {
  if (!row) return null;
  const deporte = normalizeCanchaDeporteSlug(row.deporte, { emptyDefault: 'padbol' });
  const esCustom = deporte === DEPORTE_CUSTOM;
  return {
    id: row.id,
    sede_id: row.sede_id ?? null,
    nombre: String(row.nombre || '').trim(),
    estado: row.estado != null ? String(row.estado).trim() : null,
    deporte,
    deporte_personalizado: esCustom
      ? (trimOrNull(row.deporte_personalizado, DEPORTE_PERSONALIZADO_MAX))
      : null,
    deporte_label: resolveDeporteLabel({ ...row, deporte }),
    cantidad_jugadores: esCustom && row.cantidad_jugadores != null
      ? Number(row.cantidad_jugadores)
      : null,
    modalidad_custom: esCustom
      ? (trimOrNull(row.modalidad_custom, 32))
      : null,
    duracion_sugerida_min: esCustom && row.duracion_sugerida_min != null
      ? Number(row.duracion_sugerida_min)
      : null,
    observacion_custom: esCustom
      ? (trimOrNull(row.observacion_custom, OBSERVACION_MAX))
      : null,
    es_deporte_personalizado: esCustom,
    descripcion: row.descripcion != null && String(row.descripcion).trim() !== ''
      ? String(row.descripcion).trim()
      : null,
    orden: orden != null ? orden : (row.orden != null ? Number(row.orden) : null),
  };
}

/**
 * Precio: custom usa configuración específica si existe; si no, base de sede.
 * Nunca remapea custom → padbol.
 */
export function normalizeDeporteForReservaPricing(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'futbol5') return 'futbol_5';
  if (s === 'futbol7') return 'futbol_7';
  if (s === DEPORTE_CUSTOM) return DEPORTE_CUSTOM;
  return s;
}

export function isDeporteCustom(raw) {
  return normalizeDeporteForReservaPricing(raw) === DEPORTE_CUSTOM;
}
