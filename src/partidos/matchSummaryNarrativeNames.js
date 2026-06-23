import { isTrustworthyPlayerDisplayName } from './matchSummaryDisplayNames.js';

export const DEFAULT_EQUIPO1_NOMBRE = 'Equipo 1';
export const DEFAULT_EQUIPO2_NOMBRE = 'Equipo 2';

export const GANADOR_REFERENCIAS = [
  'la pareja vencedora',
  'los ganadores',
  'la dupla ganadora',
  'el conjunto vencedor',
];

export const PERDEDOR_REFERENCIAS = [
  'la dupla rival',
  'los vencidos',
  'la pareja perdedora',
  'la pareja rival',
];

function isDefaultEquipoNombre(nombre, defaultName) {
  if (!nombre || typeof nombre !== 'string') return true;
  return String(nombre).trim() === defaultName;
}

function capitalizeFirst(value) {
  const text = String(value ?? '').trim();
  if (!text) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function getTrustworthyPlayerNames(equipo) {
  return (equipo?.jugadores ?? [])
    .map((jugador) => jugador?.nombre_display)
    .filter((name) => isTrustworthyPlayerDisplayName(name))
    .map((name) => String(name).trim());
}

/**
 * Resuelve el nombre principal para crónica (custom, dupla o genérico).
 * @param {object|null|undefined} equipo
 * @param {string} defaultName
 */
export function resolveEquipoNarrativeMeta(equipo, defaultName) {
  const customNombre = equipo?.nombre;
  if (!isDefaultEquipoNombre(customNombre, defaultName)) {
    return {
      nombre: String(customNombre).trim(),
      tipo: 'custom',
      es_generico: false,
      referencias_ganador: GANADOR_REFERENCIAS,
      referencias_perdedor: PERDEDOR_REFERENCIAS,
    };
  }

  const jugadores = getTrustworthyPlayerNames(equipo);
  if (jugadores.length >= 2) {
    const duplaLower = `la dupla de ${jugadores[0]} y ${jugadores[1]}`;
    return {
      nombre: capitalizeFirst(duplaLower),
      nombre_preposicion_a: duplaLower,
      tipo: 'dupla',
      es_generico: false,
      jugadores: jugadores.slice(0, 2),
      referencias_ganador: GANADOR_REFERENCIAS,
      referencias_perdedor: PERDEDOR_REFERENCIAS,
    };
  }

  return {
    nombre: defaultName,
    tipo: 'generico',
    es_generico: true,
    referencias_ganador: GANADOR_REFERENCIAS,
    referencias_perdedor: PERDEDOR_REFERENCIAS,
  };
}

export function resolveEquipoNarrativeLabels(payload = {}) {
  return {
    equipo1: resolveEquipoNarrativeMeta(payload?.equipos?.equipo1, DEFAULT_EQUIPO1_NOMBRE),
    equipo2: resolveEquipoNarrativeMeta(payload?.equipos?.equipo2, DEFAULT_EQUIPO2_NOMBRE),
  };
}

export function buildPerdedorReference(perdedorMeta, preposition = 'a') {
  if (!perdedorMeta) {
    return preposition === 'a' ? 'a su rival' : 'su rival';
  }

  if (perdedorMeta.tipo === 'dupla') {
    return `${preposition} ${perdedorMeta.nombre_preposicion_a}`;
  }

  if (perdedorMeta.tipo === 'custom') {
    const value = String(perdedorMeta.nombre ?? '').trim();
    if (!value) return preposition === 'a' ? 'a su rival' : 'su rival';
    if (preposition === 'a' && value.startsWith('el ')) {
      return `al ${value.slice(4)}`;
    }
    return `${preposition} ${value}`;
  }

  return preposition === 'a' ? 'sobre su rival' : 'su rival';
}

export function pickNarrativeReference(referencias, seed, salt = '0') {
  if (!referencias?.length) return 'su rival';

  let hash = 0;
  const str = `${seed ?? '0'}-${salt}`;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }

  return referencias[Math.abs(hash) % referencias.length];
}

export function countGenericTeamMentions(text) {
  const value = String(text ?? '');
  return {
    equipo1: (value.match(/Equipo 1/g) ?? []).length,
    equipo2: (value.match(/Equipo 2/g) ?? []).length,
  };
}

export function summaryRepeatsGenericTeamsTooMuch(text) {
  const counts = countGenericTeamMentions(text);
  return counts.equipo1 > 1 || counts.equipo2 > 1;
}
