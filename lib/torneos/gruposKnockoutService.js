import { buildKnockoutBracketMatches } from './knockoutBracketService.js';

function makeError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function normalizeEstado(estado) {
  return String(estado ?? '').trim().toLowerCase();
}

function hasGrupo(partido) {
  return partido?.grupo != null && String(partido.grupo).trim() !== '';
}

/**
 * Selecciona los clasificados de la tabla de grupos.
 * Soporta (por ahora) exactamente 2 grupos.
 *
 * @param {{ grupos?: Record<string, Array<object>> }} clasificacion
 * @param {{ perGroup?: number }} [opts]
 * @returns {Array<{ grupo: string, posicion: number, equipo_id: number, equipo_nombre: string | null }>}
 */
export function selectQualifiersFromClasificacion(clasificacion, { perGroup = 2 } = {}) {
  const grupos = clasificacion?.grupos ?? {};
  const groupKeys = Object.keys(grupos).sort((a, b) => a.localeCompare(b));

  if (groupKeys.length !== 2) {
    throw makeError(
      `Se soportan exactamente 2 grupos (recibidos: ${groupKeys.length})`,
      'grupos_estructura_invalida',
      400,
    );
  }

  const qualifiers = [];
  for (const key of groupKeys) {
    const rows = [...(grupos[key] ?? [])].sort(
      (a, b) => (a.posicion ?? 0) - (b.posicion ?? 0),
    );
    if (rows.length < perGroup) {
      throw makeError(
        `El grupo ${key} no tiene al menos ${perGroup} equipos (tiene ${rows.length})`,
        'grupo_sin_clasificados',
        400,
      );
    }
    for (let i = 0; i < perGroup; i += 1) {
      const row = rows[i];
      if (row?.equipo_id == null) {
        throw makeError(
          `Clasificado ${i + 1}° del grupo ${key} sin equipo_id`,
          'grupo_sin_clasificados',
          400,
        );
      }
      qualifiers.push({
        grupo: key,
        posicion: row.posicion ?? i + 1,
        equipo_id: Number(row.equipo_id),
        equipo_nombre: row.equipo_nombre ?? null,
      });
    }
  }

  return qualifiers;
}

/**
 * Ordena los clasificados para siembra cruzada.
 * 2 grupos → semifinales (1A vs 2B) y (1B vs 2A) → orden [1A, 2B, 1B, 2A].
 *
 * @param {Array<{ grupo: string, posicion: number }>} qualifiers
 * @returns {Array<object>} qualifiers en orden de siembra
 */
export function buildCrossSeedOrder(qualifiers) {
  const groups = [...new Set((qualifiers ?? []).map((q) => q.grupo))].sort(
    (a, b) => a.localeCompare(b),
  );
  if (groups.length !== 2) {
    throw makeError(
      `buildCrossSeedOrder soporta 2 grupos (recibidos: ${groups.length})`,
      'grupos_estructura_invalida',
      400,
    );
  }

  const byKey = new Map();
  for (const q of qualifiers) byKey.set(`${q.grupo}-${q.posicion}`, q);

  const pick = (grupo, posicion) => {
    const q = byKey.get(`${grupo}-${posicion}`);
    if (!q) {
      throw makeError(
        `Falta el clasificado ${posicion}° del grupo ${grupo}`,
        'grupo_sin_clasificados',
        400,
      );
    }
    return q;
  };

  const [gA, gB] = groups;
  return [pick(gA, 1), pick(gB, 2), pick(gB, 1), pick(gA, 2)];
}

/**
 * Valida que un torneo grupos_knockout esté listo para generar la llave.
 * - tipo_torneo === 'grupos_knockout'
 * - todos los partidos de grupo (grupo != null) finalizados
 * - no existe fase eliminatoria (no hay partidos con grupo == null)
 *
 * @param {{ tipoTorneo?: string, partidos?: Array<object> }} input
 * @returns {{ ok: true, grupos_partidos: number }}
 */
export function assertGruposKnockoutReady({ tipoTorneo, partidos = [] }) {
  const tipo = String(tipoTorneo ?? '').trim().toLowerCase();
  if (tipo !== 'grupos_knockout') {
    throw makeError(
      `Tipo de torneo no soportado para grupos → knockout: ${tipoTorneo ?? 'null'}`,
      'grupos_knockout_tipo_invalido',
      400,
    );
  }

  const grupoMatches = partidos.filter(hasGrupo);
  const knockoutMatches = partidos.filter((p) => !hasGrupo(p));

  if (grupoMatches.length === 0) {
    throw makeError('No hay partidos de fase de grupos', 'grupos_incompletos', 409);
  }

  const pendientes = grupoMatches.filter((p) => normalizeEstado(p.estado) !== 'finalizado');
  if (pendientes.length > 0) {
    throw makeError(
      `Fase de grupos incompleta: ${pendientes.length} partido(s) sin finalizar`,
      'grupos_incompletos',
      409,
    );
  }

  if (knockoutMatches.length > 0) {
    throw makeError('Ya existe fase eliminatoria en el torneo', 'llave_existente', 409);
  }

  return { ok: true, grupos_partidos: grupoMatches.length };
}

/**
 * Arma el plan de partidos knockout desde la fase de grupos, sin tocar la DB.
 * Reutiliza buildKnockoutBracketMatches con shuffle:false para respetar el sembrado cruzado.
 *
 * @param {{
 *   torneo: { id: number|string, sede_id?: number|null, tipo_torneo?: string },
 *   partidos?: Array<object>,
 *   clasificacion: { grupos?: Record<string, Array<object>> },
 *   perGroup?: number,
 * }} input
 * @returns {{ partidosData: Array<object>, clasificados: Array<object> }}
 */
export function buildGruposKnockoutBracketPlan({
  torneo,
  partidos = [],
  clasificacion,
  perGroup = 2,
}) {
  assertGruposKnockoutReady({ tipoTorneo: torneo?.tipo_torneo, partidos });

  const qualifiers = selectQualifiersFromClasificacion(clasificacion, { perGroup });
  const seedOrder = buildCrossSeedOrder(qualifiers);

  const partidosData = buildKnockoutBracketMatches({
    equipos: seedOrder.map((q) => ({ id: q.equipo_id })),
    torneoId: torneo.id,
    sedeId: torneo.sede_id ?? null,
    shuffle: false,
  });

  return { partidosData, clasificados: qualifiers };
}
