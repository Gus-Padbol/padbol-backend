import { MANUAL_DATE_SELECT, getManualDateParticipantIds } from './torneos/manualPlayedDateService.js';
import { MANUAL_PLAYED_DATE_CAPABILITY } from './torneos/manualPlayedDateCapability.js';
import { isTerminalScoreboardPoint, TERMINAL_POINT_SELECT } from './torneos/terminalScoreboardPoint.js';
import { verifyIncentiveTournamentClosure } from './incentiveTournamentClosure.js';
import { pickScoreboardRowForTorneoPartido } from '../src/scoreboard/scoreboardTorneoPartidoResolver.js';
import { unwrapResultadoJson } from './torneos/finalizarPartidoTorneoService.js';

export const INCENTIVE_RULES_VERSION = 'activity-v4-final-scoreboard-results-reservations12';
export const FOUR_GOAL_RULES = Object.freeze({
  torneos_integrales_minimos: 1,
  final_marcador_minimo: 1,
  parejas_confirmadas_por_torneo_minimas: 8,
  jugadores_distintos_por_torneo_minimos: 16,
  // Every played match needs a registered result; live scoreboard use is optional.
  resultados_registrados_porcentaje_minimo: 100,
  reservas_completadas_minimas: 12,
  jugadores_vinculados_activos_minimos: 10,
});
const RULE_METRICS = Object.freeze({
  torneos_integrales: {
    keys: ['final_marcador_minimo', 'torneos_integrales_minimos', 'parejas_confirmadas_por_torneo_minimas', 'jugadores_distintos_por_torneo_minimos'],
    metric: 'torneos_integrales_validos', target: 1,
  },
  resultados: { keys: ['resultados_registrados_porcentaje_minimo'], metric: 'torneos_resultados_completos', target: 1 },
  reservas: { keys: ['reservas_completadas_minimas'], metric: 'reservas_validas', target: 12 },
  jugadores_activos: { keys: ['jugadores_vinculados_activos_minimos'], metric: 'jugadores_activos', target: 10 },
});
const DEFAULT_RULES = Object.freeze({});
export const PADBOL_COURT_PRO_POLICY = Object.freeze({
  code: 'padbol_pro_renovable', version: 'pricing-v2', rulesVersion: INCENTIVE_RULES_VERSION,
  currency: 'USD', baseMonthlyUsd: 68, includedMonths: 3,
  padbolCourtMonthlyUsd: 34, objectivesMonthlyUsd: 17, billingEnabled: false,
  commercialScope: 'padbol_only', goalsCount: 4,
});

// New keys and exact approved values prevent reinterpreting legacy player targets.
export function normalizeIncentiveRules(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(Object.entries(FOUR_GOAL_RULES).filter(([key, target]) => (
    Object.hasOwn(input, key) && typeof input[key] === 'number' && input[key] === target
  )));
}

export function evaluateIncentiveMetrics(metrics = {}, rulesRaw = {}) {
  const rules = normalizeIncentiveRules(rulesRaw);
  const criteria = {}, details = {};
  for (const [criterion, spec] of Object.entries(RULE_METRICS)) {
    const raw = metrics?.[spec.metric];
    const current = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
    const configured = spec.keys.every((key) => rules[key] === FOUR_GOAL_RULES[key]);
    const met = configured && current != null ? current >= spec.target : null;
    criteria[criterion] = met;
    details[criterion] = {
      rule_key: spec.keys[0], rule_keys: spec.keys, metric_key: spec.metric,
      configured, current, target: configured ? spec.target : null,
      requirements: configured ? Object.fromEntries(spec.keys.map((key) => [key, rules[key]])) : null,
      state: !configured ? 'pending_configuration' : current == null ? 'unavailable' : met ? 'completed' : 'pending',
    };
  }
  const required = 4;
  const configuredCount = Object.values(details).filter((row) => row.configured).length;
  const completedCount = Object.values(details).filter((row) => row.state === 'completed').length;
  const complete = configuredCount === required;
  const available = Object.values(details).every((row) => row.current != null);
  return {
    rules_version: INCENTIVE_RULES_VERSION,
    cumplido: complete && available ? completedCount === required : null,
    criterios: criteria, detalle_criterios: details, configuracion_completa: complete,
    criterios_configurados: configuredCount, criterios_cumplidos: completedCount, criterios_requeridos: required,
    objetivos_pendientes_configuracion: [...new Set(Object.values(details).filter((row) => !row.configured).flatMap((row) => row.rule_keys))],
    rules,
  };
}

export function monthPeriodBounds(periodRaw = new Date()) {
  const isDate = periodRaw instanceof Date;
  const validShape = isDate || (typeof periodRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(periodRaw));
  const parsed = new Date(isDate ? periodRaw : `${periodRaw}T12:00:00Z`);
  if (!validShape || Number.isNaN(parsed.getTime())
    || (!isDate && parsed.toISOString().slice(0, 10) !== periodRaw)) {
    const error = new Error('Período inválido');
    error.status = 400;
    throw error;
  }
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1));
  const end = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1));
  return {
    period: start.toISOString().slice(0, 10),
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function padbolCourtProgramMonth(fechaInicio, periodRaw = new Date()) {
  const startRaw = String(fechaInicio || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) return null;
  const start = new Date(`${startRaw}T12:00:00Z`);
  const period = periodRaw instanceof Date
    ? new Date(periodRaw)
    : new Date(`${String(periodRaw || '').slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(period.getTime())) return null;
  const month = (
    (period.getUTCFullYear() - start.getUTCFullYear()) * 12
    + period.getUTCMonth()
    - start.getUTCMonth()
    + 1
  );
  return month > 0 ? month : 0;
}

export function buildPadbolCourtCommercialStatus({
  fechaInicio,
  period = new Date(),
  evaluation = null,
  venueScope = 'unknown',
} = {}) {
  const policy = PADBOL_COURT_PRO_POLICY;
  const programMonth = padbolCourtProgramMonth(fechaInicio, period);
  const configurationComplete = evaluation?.configuracion_completa === true;
  const objectivesMet = evaluation?.cumplido === true;
  let phase = 'start_pending';
  let projectedMonthlyUsd = null;
  let referenceMonthlyUsd = null;
  let potentialMonthlyUsd = null;

  if (venueScope !== 'padbol_only') {
    phase = venueScope === 'mixed' ? 'mixed_quote_pending' : 'venue_scope_pending';
  } else if (programMonth === 0) {
    phase = 'not_started';
  } else if (programMonth != null && programMonth <= policy.includedMonths) {
    phase = 'included';
    projectedMonthlyUsd = 0;
    referenceMonthlyUsd = 0;
    potentialMonthlyUsd = 0;
  } else if (programMonth != null) {
    referenceMonthlyUsd = policy.padbolCourtMonthlyUsd;
    potentialMonthlyUsd = policy.objectivesMonthlyUsd;
    if (!configurationComplete) {
      phase = 'objectives_configuration_pending';
    } else if (objectivesMet) {
      phase = 'objectives_met_projected';
      projectedMonthlyUsd = policy.objectivesMonthlyUsd;
    } else {
      phase = 'objectives_in_progress';
    }
  }

  return {
    currency: policy.currency,
    program_month: programMonth,
    phase,
    base_monthly_usd: policy.baseMonthlyUsd,
    included_months: policy.includedMonths,
    venue_scope: venueScope,
    padbol_court_monthly_usd: venueScope === 'padbol_only' ? policy.padbolCourtMonthlyUsd : null,
    objectives_monthly_usd: venueScope === 'padbol_only' ? policy.objectivesMonthlyUsd : null,
    projected_monthly_usd: projectedMonthlyUsd,
    reference_monthly_usd: referenceMonthlyUsd,
    potential_monthly_usd: potentialMonthlyUsd,
    objectives_configured: configurationComplete,
    objectives_met: evaluation?.cumplido ?? null,
    billing_enabled: policy.billingEnabled,
  };
}

export function addUtcMonthsDate(dateRaw, months) {
  const source = String(dateRaw || '').slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(source) ? new Date(`${source}T12:00:00Z`) : new Date();
  date.setUTCMonth(date.getUTCMonth() + Math.max(0, Number(months) || 0));
  return date.toISOString().slice(0, 10);
}

export function buildPadbolCourtProgramDraft({ sedeId, start, rules: rulesRaw, rulesVersion, now = new Date() } = {}) {
  const normalizedSedeId = Number(sedeId);
  const startDate = String(start || now.toISOString().slice(0, 10)).slice(0, 10);
  const rules = rulesVersion === INCENTIVE_RULES_VERSION ? normalizeIncentiveRules(rulesRaw) : {};
  const configurationComplete = Object.keys(rules).length === Object.keys(FOUR_GOAL_RULES).length;
  return {
    sede_id: normalizedSedeId,
    codigo: PADBOL_COURT_PRO_POLICY.code,
    estado: 'borrador',
    meses_base: PADBOL_COURT_PRO_POLICY.includedMonths,
    fecha_inicio: startDate,
    // La fecha exacta de corte/prorrateo todavía no fue decidida. No fabricar
    // un vencimiento contractual a partir de una suma de días o meses.
    fecha_fin_base: null,
    reglas_version: configurationComplete
      ? INCENTIVE_RULES_VERSION
      : `${INCENTIVE_RULES_VERSION}-pending-objectives`,
    configuracion: rules,
    updated_at: now.toISOString(),
  };
}

const normal = (value) => String(value ?? '').trim().toLowerCase();
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const uuid = (value) => {
  const candidate = normal(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate) ? candidate : null;
};
const timestamp = (value) => typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const inMonth = (value, bounds) => {
  const time = timestamp(value);
  return time != null && time >= Date.parse(bounds.startIso) && time < Date.parse(bounds.endIso);
};
const inMonthDate = (value, bounds) => {
  const date = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= bounds.startDate && date < bounds.endDate
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
};
function isWalkover(partido) {
  // resultado is an existing JSONB column. These markers are defensive only:
  // no standardized WO writer exists in the inspected application/schema.
  const result = unwrapResultadoJson(partido?.resultado);
  const marker = normal(result?.fuente_resultado).replace(/[\s_-]/g, '');
  return ['wo', 'w.o.', 'walkover', 'ausencia', 'noshow'].includes(marker);
}
function playedSetsMatch(scoreboard) {
  const history = scoreboard.historial_sets;
  const a = scoreboard.sets_a, b = scoreboard.sets_b;
  if (!Number.isInteger(a) || !Number.isInteger(b)
    || !((a === 2 && [0, 1].includes(b)) || (b === 2 && [0, 1].includes(a)))
    || !Array.isArray(history) || history.length !== a + b) return false;
  let wonA = 0, wonB = 0;
  for (let i = 0; i < history.length; i += 1) {
    const set = history[i];
    if (set?.set !== i + 1 || !Number.isInteger(set.a) || !Number.isInteger(set.b)
      || set.a < 0 || set.b < 0) return false;
    const winner = Math.max(set.a, set.b), loser = Math.min(set.a, set.b);
    if (!((winner === 6 && loser <= 4) || (winner === 7 && [5, 6].includes(loser)))) return false;
    if (set.a > set.b) wonA += 1; else wonB += 1;
    if (i < history.length - 1 && (wonA === 2 || wonB === 2)) return false;
  }
  return wonA === a && wonB === b;
}
function registeredMatchResult(partido, tournament, pairs) {
  if (normal(partido.estado) !== 'finalizado' || isWalkover(partido)) return null;
  const pa = id(partido.equipo_a_id), pb = id(partido.equipo_b_id);
  if (!pa || !pb || pa === pb || !pairs.has(pa) || !pairs.has(pb)
    || id(partido.torneo_id) !== id(tournament.id)
    || id(partido.sede_id) !== id(tournament.sede_id)) return null;
  const result = unwrapResultadoJson(partido.resultado);
  if (!result || Array.isArray(result)) return null;
  let a, b, history;
  if (['set1', 'set2', 'set3'].some((key) => Object.hasOwn(result, key))) {
    // Existing web manual writer: JSON {set1, set2, set3, ganador_id}.
    // A complete manual result proves registration, never scoreboard use.
    const values = [result.set1, result.set2];
    if (result.set3 != null && String(result.set3).trim()) values.push(result.set3);
    history = values.map((value, index) => {
      const parsed = typeof value === 'string' && value.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      return parsed ? { set: index + 1, a: Number(parsed[1]), b: Number(parsed[2]) } : null;
    });
    if (history.some((set) => !set)) return null;
    a = history.filter((set) => set.a > set.b).length;
    b = history.filter((set) => set.b > set.a).length;
    if (!playedSetsMatch({ sets_a: a, sets_b: b, historial_sets: history })) return null;
    if ((Object.hasOwn(result, 'goles_a') && result.goles_a !== a)
      || (Object.hasOwn(result, 'goles_b') && result.goles_b !== b)) return null;
  } else {
    // Existing scoreboard sync and authenticated manual-admin service both
    // persist goles_a/goles_b; that shape alone does not identify the writer.
    a = result.goles_a; b = result.goles_b;
    if (!Number.isInteger(a) || !Number.isInteger(b)
      || !((a === 2 && [0, 1].includes(b)) || (b === 2 && [0, 1].includes(a)))) return null;
    history = result.historial_sets;
    if (history != null && !playedSetsMatch({ sets_a: a, sets_b: b, historial_sets: history })) return null;
  }
  const winner = a > b ? pa : pb;
  const declaredWinners = [partido.ganador_equipo_id, result.ganador_id].filter((value) => value != null);
  if (!declaredWinners.length || declaredWinners.some((value) => id(value) !== winner)) return null;
  return { sets_a: a, sets_b: b, historial_sets: history };
}
function usedDigitalScoreboard(partido, registeredResult, scoreboard, points, tournament, bounds, { syncMustBeInMonth = true, pointMustBeInMonth = true } = {}) {
  if (!scoreboard || !registeredResult) return false;
  if (id(scoreboard.torneo_id) !== id(tournament.id) || id(scoreboard.sede_id) !== id(tournament.sede_id)
    || id(scoreboard.partido_torneo_id) !== id(partido.id)) return false;
  if (!['finalizado', 'terminado'].includes(normal(scoreboard.estado))
    || normal(scoreboard.sync_torneo_status) !== 'synced'
    || timestamp(scoreboard.synced_to_torneo_at) == null
    || (syncMustBeInMonth && !inMonth(scoreboard.synced_to_torneo_at, bounds))
    || !playedSetsMatch(scoreboard)) return false;
  if (registeredResult.sets_a !== scoreboard.sets_a || registeredResult.sets_b !== scoreboard.sets_b) return false;
  if (registeredResult.historial_sets && registeredResult.historial_sets.some((set, index) => (
    set.a !== scoreboard.historial_sets[index]?.a || set.b !== scoreboard.historial_sets[index]?.b
  ))) return false;
  // Completion, manual typing or an automatically created scoreboard row are
  // insufficient. Require a persisted point event and completed set history.
  // These records evidence use, not immutable provenance or physical presence.
  return points.some((point) => String(point.partido_id) === String(scoreboard.id)
    && ['A', 'B'].includes(point.equipo) && timestamp(point.timestamp) != null
    && (!pointMustBeInMonth || inMonth(point.timestamp, bounds))
    && Date.parse(point.timestamp) <= Date.parse(scoreboard.synced_to_torneo_at));
}

export function collectFourGoalMetrics({ tournaments = [], teams = [], matches = [], scoreboards = [], points = [], reservations = [], linkedPlayers = [], profiles = [], verifiedUserIds = new Set(), accountUserIds = new Set(), scoreboardEvidenceAvailable = true, activityEvidenceAvailable = true, manualDates = [], manualDatesEnabled = false, manualDateEvidenceAvailable = true, courts = [] }, bounds, sedeId) {
  const knownProfiles = new Set(profiles.map((row) => uuid(row.user_id)).filter(user => user && accountUserIds.has(user)));
  const venueCourts = courts.filter((row) => id(row.sede_id) === sedeId && normal(row.estado) === 'activa');
  const venueScope = venueCourts.length === 0 ? 'unknown'
    : venueCourts.every((row) => normal(row.deporte) === 'padbol') ? 'padbol_only'
      : venueCourts.some((row) => normal(row.deporte) === 'padbol') ? 'mixed' : 'non_padbol';
  const monthlyActive = new Set();
  const linkedAtVenue = new Set(linkedPlayers.filter(row => id(row.sede_id) === sedeId && normal(row.estado) === 'activo')
    .map(row => uuid(row.user_id)).filter(Boolean));
  const manualDatesByMatch = new Map();
  if (manualDatesEnabled) for (const row of manualDates) {
    const matchId = id(row.partido_id);
    // The private table has a primary key; ambiguous injected/read evidence is never selected arbitrarily.
    if (matchId) manualDatesByMatch.set(matchId, manualDatesByMatch.has(matchId) ? null : row);
  }
  const manualActivityMatchIds = new Set();
  const evidence = [];
  const tournamentsById = new Map(tournaments.filter((row) => id(row.id) && id(row.sede_id) === sedeId
    && normal(row.estado) === 'finalizado' && normal(row.deporte) === 'padbol'
    && row.formato_equipo === 'dobles' && inMonthDate(row.fecha_fin, bounds)).map((row) => [id(row.id), row]));
  let integral = 0, complete = 0;
  for (const [tournamentId, tournament] of tournamentsById) {
    // Uniqueness belongs to this tournament only. Returning pairs and players
    // remain eligible in another tournament or month; no new-player quota.
    const pairs = new Map(), participants = new Set();
    let repeatedPlayer = false;
    for (const team of teams.filter((row) => id(row.torneo_id) === tournamentId && normal(row.inscripcion_estado) === 'confirmado')) {
      const teamId = id(team.id);
      if (!teamId || pairs.has(teamId)) continue;
      const players = (Array.isArray(team.jugadores) ? team.jugadores : []).map((player) => uuid(typeof player === 'string' ? player : player?.user_id));
      if (players.length !== 2 || !players.every((userId) => userId && knownProfiles.has(userId)) || players[0] === players[1]) continue;
      if (players.some((userId) => participants.has(userId))) repeatedPlayer = true;
      players.forEach((userId) => participants.add(userId));
      pairs.set(teamId, players);
    }
    const qualifies = !repeatedPlayer && pairs.size >= FOUR_GOAL_RULES.parejas_confirmadas_por_torneo_minimas
      && participants.size >= FOUR_GOAL_RULES.jugadores_distintos_por_torneo_minimos;
    const uniqueMatches = new Map(matches.filter((row) => id(row.torneo_id) === tournamentId && id(row.id)).map((row) => [id(row.id), row]));
    const requiredMatches = [...uniqueMatches.values()].filter((row) => !['cancelado', 'cancelada'].includes(normal(row.estado)) && !isWalkover(row));
    let played = 0, digital = 0;
    const playedPairs = new Set();
    const registeredResults = new Map();
    const digitalMatchIds = new Set();
    const selectedScoreboards = new Map();
    for (const partido of requiredMatches) {
      // Reuse the production selector, including its active-row preference.
      // Filtering to completed rows first would incorrectly accept an old final
      // while a more recent active scoreboard represents a reopened match.
      const { row } = pickScoreboardRowForTorneoPartido(scoreboards.filter((scoreboard) => id(scoreboard.partido_torneo_id) === id(partido.id)));
      selectedScoreboards.set(id(partido.id), row);
      const registeredResult = registeredMatchResult(partido, tournament, pairs);
      if (!registeredResult) continue;
      registeredResults.set(id(partido.id), registeredResult);
      played += 1;
      if (usedDigitalScoreboard(partido, registeredResult, row, points, tournament, bounds)) {
        digital += 1; digitalMatchIds.add(id(partido.id));
      }
      for (const teamId of [id(partido.equipo_a_id), id(partido.equipo_b_id)]) {
        playedPairs.add(teamId);
      }
    }
    const allResultsRegistered = played > 0 && played === requiredMatches.length;
    const closure = verifyIncentiveTournamentClosure(tournament, [...uniqueMatches.values()], registeredResults, new Set(pairs.keys()));
    const resultsComplete = closure.verified && qualifies && allResultsRegistered
      && playedPairs.size >= FOUR_GOAL_RULES.parejas_confirmadas_por_torneo_minimas;
    const finalScoreboard = selectedScoreboards.get(closure.final_partido_id);
    const finalScoreboardVerified = scoreboardEvidenceAvailable
      ? digitalMatchIds.has(closure.final_partido_id)
        && points.some(point => inMonth(point.timestamp, bounds) && isTerminalScoreboardPoint(finalScoreboard, point))
      : null;
    const tournamentCompleted = resultsComplete && finalScoreboardVerified === true;
    if (tournamentCompleted) integral += 1;
    if (resultsComplete) complete += 1;
    evidence.push({ torneo_id: tournamentId, parejas_confirmadas: pairs.size, jugadores_distintos: participants.size,
      jugadores_repetidos_entre_parejas: repeatedPlayer, torneo_elegible: tournamentCompleted,
      inscripcion_elegible: qualifies, parejas_con_actividad: playedPairs.size, cierre: closure,
      final_marcador_verificado: finalScoreboardVerified,
      partidos_requeridos: requiredMatches.length, partidos_jugados_resultado_registrado: played,
      todos_resultados_registrados: allResultsRegistered, resultados_completos: resultsComplete,
      partidos_jugados_sincronizados: scoreboardEvidenceAvailable ? digital : null,
      porcentaje_uso_marcador: scoreboardEvidenceAvailable && played > 0 ? Math.round(digital / played * 100) : null,
      marcador_porcentaje_sin_minimo: true });
  }
  // Player activity belongs to the dated match event, never the tournament's
  // closing month. A still-open tournament can contribute independently of its
  // eligibility for the other two tournament goals.
  let undatedMatches = 0;
  const activityMatchIds = new Set();
  for (const tournament of tournaments) {
    if (id(tournament.sede_id) !== sedeId || normal(tournament.deporte) !== 'padbol'
      || tournament.formato_equipo !== 'dobles') continue;
    const pairs = new Map();
    for (const team of teams.filter(row => id(row.torneo_id) === id(tournament.id)
      && normal(row.inscripcion_estado) === 'confirmado')) {
      const players = (Array.isArray(team.jugadores) ? team.jugadores : [])
        .map(player => uuid(typeof player === 'string' ? player : player?.user_id));
      if (id(team.id) && players.length === 2 && players[0] !== players[1]
        && players.every(player => player && knownProfiles.has(player))) pairs.set(id(team.id), players);
    }
    for (const match of matches.filter(row => id(row.torneo_id) === id(tournament.id))) {
      if (activityMatchIds.has(id(match.id))) continue;
      const registered = registeredMatchResult(match, tournament, pairs);
      const { row: board } = pickScoreboardRowForTorneoPartido(scoreboards.filter(row => id(row.partido_torneo_id) === id(match.id)));
      const digitalParticipants = registered ? [...pairs.get(id(match.equipo_a_id)), ...pairs.get(id(match.equipo_b_id))] : [];
      const hasDigitalEvidence = registered && new Set(digitalParticipants).size === 4
        && usedDigitalScoreboard(match, registered, board, points, tournament, bounds,
          { syncMustBeInMonth: false, pointMustBeInMonth: false });
      if (hasDigitalEvidence) {
        // Real dated scoreboard evidence keeps its event month; a manual declaration cannot move it.
        if (usedDigitalScoreboard(match, registered, board, points, tournament, bounds, { syncMustBeInMonth: false })) {
          activityMatchIds.add(id(match.id));
          digitalParticipants.forEach(player => monthlyActive.add(player));
        } else undatedMatches += 1;
        continue;
      }
      const declared = manualDatesByMatch.get(id(match.id));
      const declaredParticipants = getManualDateParticipantIds(declared, match, tournament);
      const historicalPairs = declaredParticipants.length === 4
        ? new Map([[id(match.equipo_a_id),declaredParticipants.slice(0,2)], [id(match.equipo_b_id),declaredParticipants.slice(2)]])
        : new Map();
      const activeReplacement = board && ['activo','en_curso'].includes(normal(board.estado));
      if (!activeReplacement && declaredParticipants.length === 4 && inMonthDate(declared.fecha_juego,bounds)
        && registeredMatchResult(match,tournament,historicalPairs)
        && declaredParticipants.every(player => knownProfiles.has(player) && verifiedUserIds.has(player) && linkedAtVenue.has(player))) {
        declaredParticipants.forEach(player => monthlyActive.add(player));
        activityMatchIds.add(id(match.id)); manualActivityMatchIds.add(id(match.id));
      } else if (registered || declared) undatedMatches += 1;
    }
  }
  const validReservations = new Map();
  const unprovenReservationIds = new Set();
  for (const row of reservations) {
    const user = uuid(row.user_id);
    if (!id(row.id) || id(row.sede_id) !== sedeId || normal(row.deporte) !== 'padbol'
      || normal(row.estado) !== 'completada' || !inMonthDate(row.fecha, bounds)
      || row.checkin_realizado !== true || !inMonth(row.checkin_at, bounds)
      || !user || !knownProfiles.has(user) || !verifiedUserIds.has(user)) continue;
    // Booking date defines its month, not the row creation date. Check-in is
    // required because the existing completion cron only proves elapsed time.
    if (!['checkout_jugador_v1', 'encuentro_jugador_v1'].includes(row.origen_creacion)) {
      unprovenReservationIds.add(id(row.id));
      continue;
    }
    validReservations.set(id(row.id), row);
    monthlyActive.add(user);
  }
  return {
    metrics: {
      torneos_integrales_validos: scoreboardEvidenceAvailable ? integral : null,
      torneos_resultados_completos: complete,
      reservas_validas: validReservations.size,
      // Known reservation activity can already prove the minimum even when
      // scoreboard reads are unavailable; otherwise keep the criterion unknown.
      jugadores_activos: (scoreboardEvidenceAvailable && activityEvidenceAvailable && (!manualDatesEnabled || manualDateEvidenceAvailable))
        || monthlyActive.size >= FOUR_GOAL_RULES.jugadores_vinculados_activos_minimos ? monthlyActive.size : null,
    },
    venueScope, evidence,
    evidenceNotes: {
      reservas_reales_sin_origen_acreditado: unprovenReservationIds.size,
      marcador_datos_disponibles: scoreboardEvidenceAvailable,
      actividad_mensual_datos_disponibles: scoreboardEvidenceAvailable && activityEvidenceAvailable && (!manualDatesEnabled || manualDateEvidenceAvailable),
      actividad_mensual_fuente: manualDatesEnabled ? 'punto_fechado_servidor_reserva_o_fecha_declarada' : 'punto_fechado_servidor_o_reserva_acreditada',
      fecha_declarada_lectura_habilitada: manualDatesEnabled,
      fecha_declarada_datos_disponibles: manualDatesEnabled ? manualDateEvidenceAvailable : null,
      partidos_con_fecha_declarada_en_mes: manualActivityMatchIds.size,
      jugadores_activos_conteo_minimo_conocido: monthlyActive.size,
      actividad_mensual_conteo_minimo: !(scoreboardEvidenceAvailable && activityEvidenceAvailable && (!manualDatesEnabled || manualDateEvidenceAvailable)),
      partidos_con_actividad_fechada_en_mes: activityMatchIds.size,
      partidos_evaluados_sin_actividad_fechada_en_mes: undatedMatches,
    },
  };
}

async function fetchAllMetricRows(buildQuery, pageSize = 1000, orderColumn = 'id') {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await buildQuery().order(orderColumn, { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
async function fetchByIds(supabase, table, select, field, values) {
  const rows = [];
  for (let start = 0; start < values.length; start += 100) {
    rows.push(...await fetchAllMetricRows(() => supabase.from(table).select(select).in(field, values.slice(start, start + 100))));
  }
  return rows;
}
async function resolveAccountEvidence(supabase, candidateIds) {
  const result = { accountUserIds: new Set(), verifiedUserIds: new Set() };
  if (!candidateIds.length) return result;
  if (typeof supabase?.auth?.admin?.getUserById !== 'function') {
    const error = new Error('No está disponible la verificación de las cuentas participantes.');
    error.code = 'ACCOUNT_VERIFICATION_UNAVAILABLE';
    throw error;
  }
  for (let start = 0; start < candidateIds.length; start += 10) {
    await Promise.all(candidateIds.slice(start, start + 10).map(async (userId) => {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error?.status === 404) return;
      if (error) throw error;
      const user = data?.user;
      if (uuid(user?.id) !== userId || user?.is_anonymous === true || user?.deleted_at) return;
      result.accountUserIds.add(userId);
      if (timestamp(user?.email_confirmed_at) != null || timestamp(user?.phone_confirmed_at) != null) result.verifiedUserIds.add(userId);
    }));
  }
  return result;
}
async function metricsForProgram(supabase, program, bounds, { manualDatesEnabled = false } = {}) {
  const sedeId = id(program?.sede_id);
  if (!sedeId) { const error = new Error('Sede inválida'); error.status = 400; throw error; }
  const [closedTournaments, reservations, linkedPlayers, courts] = await Promise.all([
    fetchAllMetricRows(() => supabase.from('torneos').select('id,sede_id,estado,fecha_fin,deporte,formato_equipo,tipo_torneo').eq('sede_id', sedeId).eq('estado', 'finalizado').eq('deporte', 'padbol').gte('fecha_fin', bounds.startDate).lt('fecha_fin', bounds.endDate)),
    fetchAllMetricRows(() => supabase.from('reservas').select('id,sede_id,estado,user_id,fecha,deporte,checkin_realizado,checkin_at,origen_creacion').eq('sede_id', sedeId).eq('estado', 'completada').eq('deporte', 'padbol').gte('fecha', bounds.startDate).lt('fecha', bounds.endDate)),
    fetchAllMetricRows(() => supabase.from('sede_jugadores').select('id,sede_id,user_id,estado').eq('sede_id', sedeId).eq('estado', 'activo')),
    fetchAllMetricRows(() => supabase.from('canchas').select('id,sede_id,estado,deporte').eq('sede_id', sedeId).eq('estado', 'activa')),
  ]);
  let activityBoards = [], activityEvidenceAvailable = true;
  try {
    // A synchronization may happen after the event month. The lower bound is
    // only candidate discovery; actual credit requires a point timestamp inside
    // the requested month, so no upper sync bound or mutable updated_at is used.
    activityBoards = await fetchAllMetricRows(() => supabase.from('scoreboard_partidos')
      .select('id,sede_id,torneo_id,partido_torneo_id')
      .eq('sede_id', sedeId).eq('sync_torneo_status', 'synced')
      .gte('synced_to_torneo_at', bounds.startIso));
  } catch { activityEvidenceAvailable = false; }
  let manualDates = [], manualDateEvidenceAvailable = true;
  if (manualDatesEnabled) {
    try {
      manualDates = await fetchAllMetricRows(() => supabase.from('partido_fecha_juego').select(MANUAL_DATE_SELECT)
        .eq('sede_id',sedeId).eq('vigente',true).gte('fecha_juego',bounds.startDate).lt('fecha_juego',bounds.endDate),1000,'partido_id');
    } catch { manualDateEvidenceAvailable = false; }
  }
  const activityTournamentIds = [...new Set([...activityBoards,...manualDates].map(row => id(row.torneo_id)).filter(Boolean))];
  const activityTournaments = await fetchByIds(supabase, 'torneos',
    'id,sede_id,estado,fecha_fin,deporte,formato_equipo,tipo_torneo', 'id', activityTournamentIds);
  const tournaments = [...new Map([...closedTournaments, ...activityTournaments]
    .filter(row => id(row.sede_id) === sedeId && normal(row.deporte) === 'padbol' && row.formato_equipo === 'dobles')
    .map(row => [id(row.id), row])).values()];
  const tournamentIds = [...new Set(tournaments.map((row) => id(row.id)).filter(Boolean))];
  const [teams, matches] = await Promise.all([
    fetchByIds(supabase, 'equipos', 'id,torneo_id,jugadores,inscripcion_estado', 'torneo_id', tournamentIds),
    fetchByIds(supabase, 'partidos', 'id,torneo_id,sede_id,estado,resultado,equipo_a_id,equipo_b_id,ganador_equipo_id,grupo,bracket_round,bracket_position,partido_siguiente_id,partido_siguiente_slot', 'torneo_id', tournamentIds),
  ]);
  const matchIds = [...new Set(matches.map((row) => id(row.id)).filter(Boolean))];
  let scoreboards = [], points = [], scoreboardEvidenceAvailable = true;
  try {
    scoreboards = await fetchByIds(supabase, 'scoreboard_partidos', 'id,sede_id,torneo_id,partido_torneo_id,estado,sets_a,sets_b,historial_sets,sync_torneo_status,synced_to_torneo_at,updated_at', 'partido_torneo_id', matchIds);
    points = await fetchByIds(supabase, 'scoreboard_historial_puntos', TERMINAL_POINT_SELECT, 'partido_id', scoreboards.map((row) => row.id));
  } catch {
    // The final needs authoritative scoreboard evidence. If unavailable, keep
    // that criterion unknown while still evaluating registered/manual results.
    scoreboards = []; points = []; scoreboardEvidenceAvailable = false;
  }
  const reservationUserIds = [...new Set(reservations.map((row) => uuid(row.user_id)).filter(Boolean))];
  const userIds = [...new Set([...reservationUserIds, ...linkedPlayers.map((row) => uuid(row.user_id)), ...manualDates.flatMap(row => [...(Array.isArray(row.participantes_a) ? row.participantes_a : []), ...(Array.isArray(row.participantes_b) ? row.participantes_b : [])].map(uuid)), ...teams.flatMap((row) => (Array.isArray(row.jugadores) ? row.jugadores : []).map((player) => uuid(typeof player === 'string' ? player : player?.user_id)))].filter(Boolean))];
  const profiles = await fetchByIds(supabase, 'jugadores_perfil', 'id,user_id', 'user_id', userIds);
  const { verifiedUserIds, accountUserIds } = await resolveAccountEvidence(supabase, userIds);
  return collectFourGoalMetrics({ tournaments, teams, matches, scoreboards, points, reservations, linkedPlayers, profiles, verifiedUserIds, accountUserIds, scoreboardEvidenceAvailable, activityEvidenceAvailable, manualDates, manualDatesEnabled, manualDateEvidenceAvailable, courts }, bounds, sedeId);
}
function configuredRulesForProgram(program) {
  if (program?.reglas_version !== INCENTIVE_RULES_VERSION) return {};
  return normalizeIncentiveRules(program?.configuracion || {});
}

export async function evaluateSedeIncentive(supabase, program, period, { manualDatesEnabled = MANUAL_PLAYED_DATE_CAPABILITY.readEnabled } = {}) {
  const bounds = monthPeriodBounds(period);
  const { metrics, venueScope, evidence, evidenceNotes } = await metricsForProgram(supabase, program, bounds, { manualDatesEnabled: manualDatesEnabled === true });
  const evaluation = evaluateIncentiveMetrics(metrics, configuredRulesForProgram(program));
  return {
    period: bounds.period,
    metrics,
    evidence,
    evidence_notes: evidenceNotes,
    evaluation,
    requires_rules_migration: program?.reglas_version !== INCENTIVE_RULES_VERSION,
    commercial_status: buildPadbolCourtCommercialStatus({
      fechaInicio: program?.fecha_inicio,
      period: bounds.period,
      evaluation,
      venueScope,
    }),
    preview: true,
    persisted: false,
    credito_otorgado: false,
    reason_code: 'activity_v4_billing_closed',
  };
}

export async function previewSedeIncentive(supabase, program, period = new Date(), options = {}) {
  return evaluateSedeIncentive(supabase, program, period, options);
}

export function registerSedeIncentiveRoutes(app, deps) {
  const { supabase, adminListScopeFromRequest, assertUsuarioPuedeAdministrarSede, assertSuperAdminReq } = deps;

  app.get('/api/admin/incentivos', async (req, res) => {
    try {
      const scope = await adminListScopeFromRequest(req);
      if (!scope) return res.status(401).json({ error: 'No autorizado' });
      const requested = id(req.query?.sede_id);
      if (req.query?.sede_id != null && requested == null) return res.status(400).json({ error: 'Sede inválida' });
      let sedeIds = [];
      if (requested != null) {
        await assertUsuarioPuedeAdministrarSede(req, requested);
        sedeIds = [requested];
      } else if (scope.superA) {
        const { data, error } = await supabase.from('sedes').select('id');
        if (error) throw error;
        sedeIds = (data || []).map((row) => Number(row.id)).filter(Number.isFinite);
      } else {
        return res.status(400).json({ error: 'Selecciona una sede' });
      }
      if (!sedeIds.length) return res.json({ policy: PADBOL_COURT_PRO_POLICY, programs: [] });
      const { data: programs, error } = await supabase.from('sede_programas_beneficios').select('*').in('sede_id', sedeIds).eq('codigo', 'padbol_pro_renovable');
      if (error) throw error;
      const ids = (programs || []).map((row) => row.id);
      let progress = [];
      if (ids.length) {
        const progressResult = await supabase.from('sede_beneficio_progreso').select('*').in('programa_id', ids).order('periodo', { ascending: false }).limit(120);
        if (progressResult.error) throw progressResult.error;
        progress = progressResult.data || [];
      }
      const decorated = await Promise.all((programs || []).map(async (program) => {
        let currentProgress = null;
        let progressReasonCode = null;
        if (program.reglas_version !== INCENTIVE_RULES_VERSION) {
          progressReasonCode = 'rules_migration_required';
        } else {
          try {
            currentProgress = await previewSedeIncentive(supabase, program, new Date());
          } catch {
            progressReasonCode = 'metrics_unavailable';
          }
        }
        return {
          ...program,
          progreso: progress.filter((row) => row.programa_id === program.id),
          current_progress: currentProgress,
          progress_reason_code: progressReasonCode,
          legacy_configuration: program.reglas_version !== INCENTIVE_RULES_VERSION,
        };
      }));
      return res.json({ policy: PADBOL_COURT_PRO_POLICY, programs: decorated });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/admin/incentivos/:sedeId/activar', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const sedeId = id(req.params.sedeId);
      if (sedeId == null) return res.status(400).json({ error: 'Sede inválida' });
      if (req.body?.estado && req.body.estado !== 'borrador') return res.status(409).json({
        code: 'COMMERCIAL_ACTIVATION_CLOSED', error: 'Sólo se permite preparar un borrador sin facturación.',
      });
      const { data: sede, error: sedeError } = await supabase
        .from('sedes')
        .select('id, stripe_subscription_id')
        .eq('id', sedeId)
        .maybeSingle();
      if (sedeError) throw sedeError;
      if (!sede) return res.status(404).json({ error: 'Sede no encontrada' });
      if (String(sede.stripe_subscription_id || '').trim()) {
        return res.status(409).json({
          error: 'La sede tiene una suscripción automática activa. Pausá primero la facturación para evitar un cobro durante el beneficio.',
        });
      }
      if (req.body?.reglas_version !== INCENTIVE_RULES_VERSION
        || Object.keys(normalizeIncentiveRules(req.body?.configuracion)).length !== Object.keys(FOUR_GOAL_RULES).length) {
        return res.status(409).json({ code: 'EXPLICIT_RULES_VERSION_REQUIRED', error: 'Confirma la versión y las cuatro metas antes de cambiar el programa.' });
      }
      const existing = await supabase.from('sede_programas_beneficios').select('id')
        .eq('sede_id', sedeId).eq('codigo', PADBOL_COURT_PRO_POLICY.code).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return res.status(409).json({
        code: 'PROGRAM_ALREADY_EXISTS', error: 'La sede ya tiene un programa. Esta acción no lo reemplaza.',
      });
      // Insert-only: the unique (sede_id,codigo) constraint also protects races.
      // No legacy program migration, credit RPC, subscription or plan activation.
      const payload = buildPadbolCourtProgramDraft({
        sedeId,
        start: req.body?.fecha_inicio,
        rules: req.body?.configuracion,
        rulesVersion: req.body?.reglas_version,
      });
      const { data, error } = await supabase.from('sede_programas_beneficios').insert(payload).select('*').single();
      if (error?.code === '23505') return res.status(409).json({
        code: 'PROGRAM_ALREADY_EXISTS', error: 'La sede ya tiene un programa. Esta acción no lo reemplaza.',
      });
      if (error) throw error;
      return res.status(201).json(data);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.patch('/api/admin/incentivos/:sedeId', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const sedeId = id(req.params.sedeId);
      if (sedeId == null) return res.status(400).json({ error: 'Sede inválida' });
      const rules = normalizeIncentiveRules(req.body?.configuracion || {});
      if (req.body?.reglas_version !== INCENTIVE_RULES_VERSION
        || Object.keys(rules).length !== Object.keys(FOUR_GOAL_RULES).length) {
        return res.status(409).json({ code: 'EXPLICIT_RULES_VERSION_REQUIRED', error: 'Confirma la versión y las cuatro metas antes de cambiar el programa.' });
      }
      const patch = {
        configuracion: rules,
        reglas_version: INCENTIVE_RULES_VERSION,
        updated_at: new Date().toISOString(),
      };
      if (req.body?.estado && req.body.estado !== 'borrador') {
        return res.status(409).json({
          error: 'La activación comercial permanece cerrada hasta definir objetivos y facturación.',
          code: 'COMMERCIAL_ACTIVATION_CLOSED',
        });
      }
      const { data, error } = await supabase.from('sede_programas_beneficios').update(patch)
        .eq('sede_id', sedeId).eq('codigo', 'padbol_pro_renovable').eq('estado', 'borrador')
        .eq('reglas_version', INCENTIVE_RULES_VERSION).select('*').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ code: 'PROGRAM_REQUIRES_V4_DRAFT', error: 'Sólo se pueden editar borradores que ya tengan las cuatro metas. Los programas anteriores permanecen intactos.' });
      return res.json(data);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/admin/incentivos/:sedeId/evaluar', async (req, res) => {
    try {
      const sedeId = id(req.params.sedeId);
      if (sedeId == null) return res.status(400).json({ error: 'Sede inválida' });
      await assertUsuarioPuedeAdministrarSede(req, sedeId);
      const requestedPeriod = req.body?.periodo ?? new Date();
      const bounds = monthPeriodBounds(requestedPeriod);
      if ((typeof requestedPeriod === 'string' && requestedPeriod !== bounds.period)
        || bounds.period > monthPeriodBounds(new Date()).period) {
        return res.status(400).json({ error: 'Selecciona un mes válido hasta el mes actual.' });
      }
      const { data: program, error } = await supabase.from('sede_programas_beneficios').select('*').eq('sede_id', sedeId).eq('codigo', 'padbol_pro_renovable').maybeSingle();
      if (error) throw error;
      if (!program) return res.status(404).json({ error: 'La sede no tiene un programa activo' });
      if (program.reglas_version !== INCENTIVE_RULES_VERSION) return res.status(409).json({
        code: 'RULES_MIGRATION_REQUIRED', error: 'El programa conserva las reglas anteriores. No se ha migrado a las cuatro metas.',
      });
      return res.json(await evaluateSedeIncentive(supabase, program, requestedPeriod));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });
}

export async function evaluateAllActiveSedeIncentives(supabase, period = new Date()) {
  const { data, error } = await supabase.from('sede_programas_beneficios').select('*').eq('codigo', 'padbol_pro_renovable').eq('estado', 'activo');
  if (error) throw error;
  const results = [];
  for (const program of data || []) {
    try {
      results.push({ programa_id: program.id, ok: true, ...(await evaluateSedeIncentive(supabase, program, period, 'cron')) });
    } catch (evaluationError) {
      results.push({ programa_id: program.id, ok: false, error: evaluationError.message });
    }
  }
  return results;
}

export async function reconcileExpiredSedeIncentives() {
  const error = new Error(
    'La reconciliación anterior otorgaba meses gratis y no corresponde al esquema comercial vigente.',
  );
  error.status = 409;
  error.code = 'LEGACY_INCENTIVE_RECONCILIATION_DISABLED';
  throw error;
}

export { DEFAULT_RULES };
