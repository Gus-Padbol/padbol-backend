/**
 * Etiquetas de cancha/sede para encabezado de marcador (control móvil, TV, admin).
 * Nunca fabricar "Sede #<id>" ni mostrar placeholders demo tipo "Court One".
 */

const COURT_WORD_TO_NUM = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
});

const DEMO_COURT_RE = /^court\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)$/i;
const CANCHA_NUM_RE = /^cancha\s*(\d+)$/i;
const SEDE_HASH_RE = /^sede\s*#?\s*\d+$/i;

function trimOrNull(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t ? t : null;
}

export function isDemoCourtPlaceholder(raw) {
  const s = trimOrNull(raw);
  if (!s) return false;
  return DEMO_COURT_RE.test(s);
}

export function isSedeIdPlaceholder(raw) {
  const s = trimOrNull(raw);
  if (!s) return false;
  return SEDE_HASH_RE.test(s);
}

/** Extrae número de cancha desde "Court One", "Cancha 1", "1", etc. */
export function extractCourtNumber(raw) {
  const s = trimOrNull(raw);
  if (!s) return null;

  const demo = s.match(DEMO_COURT_RE);
  if (demo) {
    const token = String(demo[1]).toLowerCase();
    if (/^\d+$/.test(token)) {
      const n = Number(token);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return COURT_WORD_TO_NUM[token] ?? null;
  }

  const cancha = s.match(CANCHA_NUM_RE);
  if (cancha) {
    const n = Number(cancha[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  return null;
}

function sortCanchasForSede(canchas) {
  const list = Array.isArray(canchas) ? [...canchas] : [];
  list.sort((a, b) => Number(a?.id) - Number(b?.id));
  return list.map((row, index) => {
    const orden = row?.orden != null && row.orden !== '' ? Number(row.orden) : NaN;
    const numero = Number.isFinite(orden) && orden > 0
      ? orden
      : (row?.numero_reserva != null ? Number(row.numero_reserva) : index + 1);
    return { ...row, _numero: Number.isFinite(numero) && numero > 0 ? numero : index + 1 };
  });
}

/**
 * Prioridad:
 * 1) cancha_nombre real ya resuelto
 * 2) match en relación canchas (nombre / número)
 * 3) cancha embebida normalizada (nunca "Court One")
 * 4) "Cancha"
 */
export function resolveScoreboardCanchaLabel(partido, { canchas } = {}) {
  const preferred = trimOrNull(partido?.cancha_nombre);
  if (preferred && !isDemoCourtPlaceholder(preferred) && !isSedeIdPlaceholder(preferred)) {
    return preferred;
  }

  const raw = trimOrNull(partido?.cancha);
  const sorted = sortCanchasForSede(canchas);

  if (raw && sorted.length) {
    const byName = sorted.find(
      (c) => String(c?.nombre || '').trim().toLowerCase() === raw.toLowerCase(),
    );
    if (byName?.nombre) return String(byName.nombre).trim();

    const num = extractCourtNumber(raw);
    if (num != null) {
      const byNum = sorted.find((c) => Number(c._numero) === num);
      if (byNum?.nombre) return String(byNum.nombre).trim();
    }
  }

  if (raw && !isDemoCourtPlaceholder(raw) && !isSedeIdPlaceholder(raw)) {
    if (/^\d+$/.test(raw)) return `Cancha ${raw}`;
    return raw;
  }

  const num = extractCourtNumber(raw);
  if (num != null) return `Cancha ${num}`;

  return 'Cancha';
}

/**
 * Solo nombres reales. Nunca "Sede #<id>".
 */
export function resolveScoreboardSedeLabel(partido, { sedeNombre } = {}) {
  const candidates = [
    partido?.sede_nombre,
    partido?.sedeNombre,
    sedeNombre,
    partido?.sede?.nombre,
  ];
  for (const value of candidates) {
    const label = trimOrNull(value);
    if (label && !isSedeIdPlaceholder(label)) return label;
  }
  return null;
}

export function formatScoreboardVenueHeader(partido, context = {}) {
  const canchaLabel = resolveScoreboardCanchaLabel(partido, context);
  const sedeLabel = resolveScoreboardSedeLabel(partido, context);
  if (sedeLabel) return `${canchaLabel} · ${sedeLabel}`;
  return canchaLabel;
}

/**
 * Aplica etiquetas de venue al DTO público del scoreboard.
 */
export function applyScoreboardVenueLabels(partido, context = {}) {
  if (!partido || typeof partido !== 'object') return partido;
  const cancha_nombre = resolveScoreboardCanchaLabel(partido, context);
  const sede_nombre = resolveScoreboardSedeLabel(partido, context);
  return {
    ...partido,
    cancha_nombre,
    sede_nombre,
  };
}
