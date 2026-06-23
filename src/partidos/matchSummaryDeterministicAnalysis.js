import {
  isTrustworthyPlayerDisplayName,
  sanitizePlayerDisplayNameForSummary,
  summaryContainsAdministrativeLanguage,
  summaryContainsUntrustworthyIdentifiers,
} from './matchSummaryDisplayNames.js';

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export const DEFAULT_EQUIPO1_NOMBRE = 'Equipo 1';
export const DEFAULT_EQUIPO2_NOMBRE = 'Equipo 2';

function isDefaultEquipoNombre(nombre, defaultName) {
  if (!nombre || typeof nombre !== 'string') return true;
  return String(nombre).trim() === defaultName;
}

function mapJugadores(equipo) {
  return (equipo?.jugadores ?? [])
    .map((jugador) => sanitizePlayerDisplayNameForSummary(jugador?.nombre_display, null))
    .filter(Boolean);
}

export function resolveEquipoDisplayName(equipo, defaultName) {
  const customNombre = equipo?.nombre;
  if (!isDefaultEquipoNombre(customNombre, defaultName)) {
    return String(customNombre).trim();
  }

  return defaultName;
}

function resolveEquipoLabels(payload) {
  return {
    equipo1: resolveEquipoDisplayName(payload?.equipos?.equipo1, DEFAULT_EQUIPO1_NOMBRE),
    equipo2: resolveEquipoDisplayName(payload?.equipos?.equipo2, DEFAULT_EQUIPO2_NOMBRE),
  };
}

function getPerdedorKey(ganadorKey) {
  return ganadorKey === 'equipo1' ? 'equipo2' : 'equipo1';
}

function normalizeSetDetail(row) {
  if (!row || typeof row !== 'object') return null;

  const eq1 = Number(row.equipo1 ?? row.eq1);
  const eq2 = Number(row.equipo2 ?? row.eq2);

  if (!Number.isFinite(eq1) || !Number.isFinite(eq2)) return null;

  return { eq1, eq2 };
}

function formatSetScore(set) {
  return `${set.eq1}-${set.eq2}`;
}

function formatParcialesList(sets) {
  if (!sets.length) return '';

  if (sets.length === 1) {
    return formatSetScore(sets[0]);
  }

  const allButLast = sets.slice(0, -1).map(formatSetScore).join(', ');
  const last = formatSetScore(sets[sets.length - 1]);
  return `${allButLast} y ${last}`;
}

function formatSetScoreForTeam(teamKey, set) {
  if (teamKey === 'equipo1') return `${set.eq1}-${set.eq2}`;
  return `${set.eq2}-${set.eq1}`;
}

function ganadorGanoSet(ganadorKey, set) {
  if (ganadorKey === 'equipo1') return set.eq1 > set.eq2;
  if (ganadorKey === 'equipo2') return set.eq2 > set.eq1;
  return false;
}

function gamesDifference(set) {
  return Math.abs(set.eq1 - set.eq2);
}

function sumTotalGames(setsDetalle) {
  return setsDetalle.reduce((total, set) => total + set.eq1 + set.eq2, 0);
}

export function formatFechaEspanol(fecha) {
  if (!fecha) return null;

  const value = String(fecha).slice(0, 10);
  const [year, month, day] = value.split('-');

  if (!year || !month || !day) return null;

  const monthIndex = Number(month) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;

  return `${Number(day)} de ${MESES_ES[monthIndex]} de ${year}`;
}

function resolveDuracionMinutos(payload) {
  const cronometroSegundos = payload?.scoreboard_opcional?.cronometro_segundos;
  if (cronometroSegundos == null) return null;

  const seconds = Number(cronometroSegundos);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const fromPayload = payload?.scoreboard_opcional?.duracion_aproximada_minutos;
  if (Number.isFinite(fromPayload) && fromPayload > 0) {
    return fromPayload;
  }

  return Math.max(1, Math.round(seconds / 60));
}

function resolvePlantillaFallback({
  fue2_0,
  fue2_1,
  tercerSetDecisivo,
  perdedorReaccionoSegundoSet,
  ganadorCerroFuerteUltimoSet,
  partidoAjustado,
  dominioClaro2_0,
}) {
  if (fue2_0) {
    return dominioClaro2_0 ? '2_0_claro' : '2_0_solido';
  }

  if (fue2_1 && tercerSetDecisivo) {
    if (ganadorCerroFuerteUltimoSet && !partidoAjustado) {
      return '2_1_cierre_fuerte';
    }
    if (perdedorReaccionoSegundoSet && partidoAjustado) {
      return '2_1_ajustado';
    }
    return ganadorCerroFuerteUltimoSet ? '2_1_cierre_fuerte' : '2_1_ajustado';
  }

  return 'sets_generico';
}

function analyzeSetsMatch(payload, ganadorKey, perdedorKey, equipoLabels) {
  const setsDetalle = (payload?.resultado?.sets?.sets_detalle ?? [])
    .map(normalizeSetDetail)
    .filter(Boolean);

  const e1Sets = Number(payload?.resultado?.sets?.equipo1_sets) || 0;
  const e2Sets = Number(payload?.resultado?.sets?.equipo2_sets) || 0;
  const ganadorSets = ganadorKey === 'equipo1' ? e1Sets : e2Sets;
  const perdedorSets = ganadorKey === 'equipo1' ? e2Sets : e1Sets;

  const fue2_0 = ganadorSets === 2 && perdedorSets === 0;
  const fue2_1 = ganadorSets === 2 && perdedorSets === 1;
  const tercerSetDecisivo = setsDetalle.length >= 3 && fue2_1;

  const perdedorReaccionoSegundoSet = Boolean(
    tercerSetDecisivo
    && setsDetalle.length >= 2
    && ganadorGanoSet(ganadorKey, setsDetalle[0])
    && !ganadorGanoSet(ganadorKey, setsDetalle[1]),
  );

  const ultimoSet = setsDetalle[setsDetalle.length - 1] ?? null;
  const ganadorCerroFuerteUltimoSet = Boolean(
    ultimoSet
    && ganadorGanoSet(ganadorKey, ultimoSet)
    && gamesDifference(ultimoSet) >= 2,
  );

  let setMasParejo = null;
  let setMasDominante = null;
  let diferenciaTotalGames = 0;

  setsDetalle.forEach((set, index) => {
    const diff = gamesDifference(set);
    diferenciaTotalGames += ganadorGanoSet(ganadorKey, set) ? diff : -diff;

    if (!setMasParejo || diff < setMasParejo.diferencia_games) {
      setMasParejo = {
        indice: index + 1,
        parcial: formatSetScore(set),
        diferencia_games: diff,
      };
    }

    if (!setMasDominante || diff > setMasDominante.diferencia_games) {
      setMasDominante = {
        indice: index + 1,
        parcial: formatSetScore(set),
        diferencia_games: diff,
      };
    }
  });

  const partidoCambiante = fue2_1 && perdedorReaccionoSegundoSet;
  const partidoAjustado = Boolean(
    setMasParejo?.diferencia_games != null && setMasParejo.diferencia_games <= 2,
  ) || Math.abs(diferenciaTotalGames) <= 3;
  const partidoParejo = Math.abs(diferenciaTotalGames) <= 3 || partidoAjustado;
  const dominioClaro2_0 = Boolean(
    fue2_0
    && setsDetalle.length >= 2
    && setsDetalle.every((set) => ganadorGanoSet(ganadorKey, set) && gamesDifference(set) >= 2),
  );

  const plantillaFallback = resolvePlantillaFallback({
    fue2_0,
    fue2_1,
    tercerSetDecisivo,
    perdedorReaccionoSegundoSet,
    ganadorCerroFuerteUltimoSet,
    partidoAjustado,
    dominioClaro2_0,
  });

  return {
    formato: 'sets',
    ganador: {
      key: ganadorKey,
      nombre: equipoLabels[ganadorKey],
    },
    perdedor: {
      key: perdedorKey,
      nombre: equipoLabels[perdedorKey],
    },
    resultado_final_sets: {
      ganador: ganadorSets,
      perdedor: perdedorSets,
      texto: `${ganadorSets}-${perdedorSets}`,
      texto_sets: `${ganadorSets} sets a ${perdedorSets}`,
    },
    marcador_texto: `${ganadorSets}-${perdedorSets}`,
    parciales: setsDetalle.map(formatSetScore),
    parciales_texto: formatParcialesList(setsDetalle),
    sets_detalle: setsDetalle,
    total_games: sumTotalGames(setsDetalle),
    fue_2_0: fue2_0,
    fue_2_1: fue2_1,
    tercer_set_decisivo: tercerSetDecisivo,
    perdedor_reacciono_segundo_set: perdedorReaccionoSegundoSet,
    ganador_cerro_fuerte_ultimo_set: ganadorCerroFuerteUltimoSet,
    partido_ajustado: partidoAjustado,
    partido_parejo: partidoParejo,
    dominio_claro_2_0: dominioClaro2_0,
    set_mas_parejo: setMasParejo,
    set_mas_dominante: setMasDominante,
    diferencia_total_games: diferenciaTotalGames,
    plantilla_fallback: plantillaFallback,
    frases_sugeridas: {
      partido_ajustado: partidoAjustado,
      partido_parejo: partidoParejo,
      partido_cambiante: partidoCambiante,
      definido_en_tercer_set: tercerSetDecisivo,
      reaccion_segundo_parcial: perdedorReaccionoSegundoSet,
      cierre_con_autoridad: ganadorCerroFuerteUltimoSet,
      dominio_claro: dominioClaro2_0,
      buen_nivel_perdedor: partidoParejo,
    },
    formatSetScoreForTeam,
  };
}

function analyzePuntosMatch(payload, ganadorKey, perdedorKey, equipoLabels) {
  const marcador = payload?.resultado?.marcador_texto
    ?? `${payload?.resultado?.puntos_agregados?.equipo1}-${payload?.resultado?.puntos_agregados?.equipo2}`;

  return {
    formato: 'puntos_agregados',
    ganador: {
      key: ganadorKey,
      nombre: equipoLabels[ganadorKey],
    },
    perdedor: {
      key: perdedorKey,
      nombre: equipoLabels[perdedorKey],
    },
    resultado_final_sets: null,
    marcador_texto: marcador,
    parciales: [],
    parciales_texto: null,
    sets_detalle: [],
    fue_2_0: false,
    fue_2_1: false,
    tercer_set_decisivo: false,
    perdedor_reacciono_segundo_set: false,
    ganador_cerro_fuerte_ultimo_set: false,
    partido_ajustado: false,
    partido_parejo: false,
    dominio_claro_2_0: false,
    set_mas_parejo: null,
    set_mas_dominante: null,
    diferencia_total_games: null,
    plantilla_fallback: 'puntos_agregados',
    frases_sugeridas: {
      partido_ajustado: false,
      partido_parejo: false,
      partido_cambiante: false,
      definido_en_tercer_set: false,
      reaccion_segundo_parcial: false,
      cierre_con_autoridad: false,
      dominio_claro: false,
      buen_nivel_perdedor: false,
    },
    formatSetScoreForTeam,
  };
}

/**
 * Análisis determinístico previo al prompt IA / fallback deportivo.
 * @param {object} payload
 */
export function buildMatchSummaryDeterministicAnalysis(payload = {}) {
  const equipoLabels = resolveEquipoLabels(payload);
  const ganadorKey = payload?.resultado?.ganador ?? null;
  const perdedorKey = ganadorKey ? getPerdedorKey(ganadorKey) : null;

  const base = {
    ganador: ganadorKey
      ? { key: ganadorKey, nombre: equipoLabels[ganadorKey] }
      : null,
    perdedor: perdedorKey
      ? { key: perdedorKey, nombre: equipoLabels[perdedorKey] }
      : null,
    sede: payload?.contexto?.sede_nombre ?? null,
    fecha_espanol: formatFechaEspanol(payload?.contexto?.fecha),
    duracion_minutos: resolveDuracionMinutos(payload),
    equipos: {
      equipo1: {
        nombre: equipoLabels.equipo1,
        jugadores: mapJugadores(payload?.equipos?.equipo1),
      },
      equipo2: {
        nombre: equipoLabels.equipo2,
        jugadores: mapJugadores(payload?.equipos?.equipo2),
      },
    },
  };

  if (!ganadorKey || payload?.resultado?.formato === 'desconocido') {
    return {
      ...base,
      formato: payload?.resultado?.formato ?? 'desconocido',
      resultado_final_sets: null,
      parciales: [],
      parciales_texto: null,
      plantilla_fallback: 'insuficiente',
      frases_sugeridas: {
        partido_ajustado: false,
        partido_parejo: false,
        partido_cambiante: false,
        definido_en_tercer_set: false,
        reaccion_segundo_parcial: false,
        cierre_con_autoridad: false,
        dominio_claro: false,
        buen_nivel_perdedor: false,
      },
    };
  }

  if (payload.resultado.formato === 'sets') {
    return {
      ...base,
      ...analyzeSetsMatch(payload, ganadorKey, perdedorKey, equipoLabels),
    };
  }

  return {
    ...base,
    ...analyzePuntosMatch(payload, ganadorKey, perdedorKey, equipoLabels),
  };
}

export {
  formatParcialesList,
  formatSetScore,
  formatSetScoreForTeam,
  ganadorGanoSet,
  getPerdedorKey,
  normalizeSetDetail,
  resolveEquipoLabels,
};
