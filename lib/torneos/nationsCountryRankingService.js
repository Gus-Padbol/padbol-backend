import { rankingTournamentEligible } from './rankingTournamentEligibility.js';

const ISO_COUNTRY = /^[A-Z]{2}$/;
const error = (message, code = 'NATIONS_COUNTRY_RANKING_DATA_INVALID', status = 503) =>
  Object.assign(new Error(message), { code, status });
const positiveId = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
const cleanText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function optionsChecked({ now = new Date(), isRevealed } = {}) {
  if (typeof isRevealed !== 'function') throw error('Falta comprobar la publicación de los resultados.');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw error('Fecha de consulta inválida.');
  return { now, isRevealed };
}

/**
 * The only accepted country source is the validated Nations plan
 * (`plan_nations.config.country_by_team`). It must map every selection to one
 * unique uppercase ISO code; a repeated or malformed country fails closed
 * instead of guessing from names, rosters or FIPA CSV.
 */
function countryByTeam(torneo) {
  const mapping = torneo?.plan_nations?.config?.country_by_team;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw error('No se pudo comprobar el país de las selecciones publicadas.');
  }
  const byTeam = new Map();
  const seenCountries = new Set();
  for (const [teamId, raw] of Object.entries(mapping)) {
    const id = positiveId(teamId);
    const iso = typeof raw === 'string' ? raw.trim() : '';
    if (!id || !ISO_COUNTRY.test(iso) || seenCountries.has(iso)) {
      throw error('No se pudo comprobar el país de las selecciones publicadas.');
    }
    byTeam.set(id, iso);
    seenCountries.add(iso);
  }
  if (!byTeam.size) throw error('No se pudo comprobar el país de las selecciones publicadas.');
  return byTeam;
}

function countryRow(iso) {
  return { pais: iso, puntos_total: 0, torneos_count: 0, torneos_pendientes: 0, torneos: [] };
}

/**
 * Accumulated country ranking. A country receives the approved points of its
 * selection exactly once per published tournament: roster size, the number of
 * players or the number of point rows never multiply the award.
 *
 * Only finalized, non-QA, publicly revealed Nations events with a validated
 * `country_by_team` plan are projected; drafts, QA rows and embargoed events
 * are dropped before any award is read.
 *
 * A missing `tabla_puntos` row is reported as pending, never as a real zero.
 * A stored zero is a real zero. Tied totals share the same position and no
 * secondary tie-break is invented.
 */
export function buildNationsCountryRanking({ torneos = [], equipos = [], puntos = [] } = {}, options = {}) {
  const { now, isRevealed } = optionsChecked(options);
  const events = new Map();

  for (const torneo of torneos) {
    // Without the validated Nations plan there is no auditable country source,
    // so legacy selections are never extrapolated from rosters.
    if (!torneo?.plan_nations) continue;
    if (!rankingTournamentEligible(torneo)) continue;
    if (torneo.deporte !== 'padbol' || torneo.modalidad_plantel !== 'selecciones' || torneo.estado !== 'finalizado') continue;
    if (isRevealed(torneo, now) !== true) continue;
    const id = positiveId(torneo.id);
    if (!id) throw error('Un torneo publicado tiene una identidad inválida.');
    events.set(id, torneo);
  }
  if (!events.size) return [];

  const teamsByEvent = new Map();
  for (const equipo of equipos) {
    const torneoId = positiveId(equipo?.torneo_id);
    if (!events.has(torneoId)) continue;
    const id = positiveId(equipo.id);
    if (!id) throw error('No se pudo comprobar la selección de los puntos publicados.');
    if (!teamsByEvent.has(torneoId)) teamsByEvent.set(torneoId, new Set());
    teamsByEvent.get(torneoId).add(id);
  }

  const pointsByEvent = new Map();
  const seenRows = new Set();
  for (const point of puntos) {
    const torneoId = positiveId(point?.torneo_id);
    if (!events.has(torneoId)) continue;
    const equipoId = positiveId(point.equipo_id);
    if (!equipoId) throw error('No se pudo comprobar la selección de los puntos publicados.');
    if (seenRows.has(`${torneoId}:${equipoId}`)) throw error('Los puntos publicados tienen una clasificación incoherente.');
    seenRows.add(`${torneoId}:${equipoId}`);
    if (!Number.isSafeInteger(point.puntos) || point.puntos < 0 || point.puntos > 2147483647) {
      throw error('Los puntos publicados tienen una clasificación incoherente.');
    }
    if (!Number.isSafeInteger(point.posicion) || point.posicion < 1) {
      throw error('Los puntos publicados tienen una clasificación incoherente.');
    }
    if (!pointsByEvent.has(torneoId)) pointsByEvent.set(torneoId, new Map());
    pointsByEvent.get(torneoId).set(equipoId, { posicion: point.posicion, puntos: point.puntos });
  }

  const countries = new Map();
  const awardedCountries = new Set();
  const ensure = (iso) => {
    if (!countries.has(iso)) countries.set(iso, countryRow(iso));
    return countries.get(iso);
  };

  for (const [torneoId, torneo] of events) {
    const mapping = countryByTeam(torneo);
    const teamIds = new Set(teamsByEvent.get(torneoId) ?? []);
    const awarded = pointsByEvent.get(torneoId) ?? new Map();
    for (const equipoId of awarded.keys()) teamIds.add(equipoId);
    for (const equipoId of teamIds) {
      const iso = mapping.get(equipoId);
      if (!iso) throw error('No se pudo comprobar el país de las selecciones publicadas.');
      const country = ensure(iso);
      const award = awarded.get(equipoId);
      if (!award) {
        country.torneos_pendientes += 1;
        continue;
      }
      const awardKey = `${torneoId}:${iso}`;
      if (awardedCountries.has(awardKey)) throw error('Un país no puede recibir dos posiciones en el mismo torneo.');
      awardedCountries.add(awardKey);
      country.puntos_total += award.puntos;
      country.torneos_count += 1;
      country.torneos.push({
        torneo_id: torneoId,
        torneo_nombre: cleanText(torneo.nombre),
        posicion: award.posicion,
        puntos: award.puntos,
        fecha: cleanText(torneo.fecha_fin) ?? cleanText(torneo.fecha_inicio),
      });
    }
  }

  const rows = [...countries.values()];
  const ranked = rows
    .filter((row) => row.torneos_count > 0)
    .sort((a, b) => b.puntos_total - a.puntos_total || a.pais.localeCompare(b.pais, 'en'));
  const onlyPending = rows
    .filter((row) => row.torneos_count === 0)
    .sort((a, b) => a.pais.localeCompare(b.pais, 'en'));

  let position = 0;
  let previousPoints = null;
  ranked.forEach((row, index) => {
    // Competition ranking: tied countries share the position, the next one skips.
    if (row.puntos_total !== previousPoints) {
      position = index + 1;
      previousPoints = row.puntos_total;
    }
    row.posicion = position;
    row.pendiente = false;
    row.torneos.sort((a, b) => a.torneo_id - b.torneo_id);
  });
  onlyPending.forEach((row) => {
    row.posicion = null;
    row.pendiente = true;
    row.torneos = [];
  });
  return [...ranked, ...onlyPending];
}

/**
 * Reads only the whitelisted columns needed for the projection. Rosters,
 * e-mails and player identities are never fetched by this loader.
 */
export async function loadNationsCountryRanking(db, options = {}) {
  const checked = optionsChecked(options);
  const { data: torneos, error: torneosError } = await db
    .from('torneos')
    .select('id,nombre,estado,deporte,modalidad_plantel,plan_nations,fecha_inicio,fecha_fin,nivel_torneo,horas_revelar_equipos,es_prueba')
    .eq('estado', 'finalizado')
    .eq('deporte', 'padbol')
    .eq('modalidad_plantel', 'selecciones');
  if (torneosError || !Array.isArray(torneos)) throw error('No se pudieron comprobar los torneos publicados.', 'NATIONS_COUNTRY_RANKING_UNAVAILABLE', 503);

  const visible = torneos.filter(
    (torneo) => torneo?.plan_nations
      && rankingTournamentEligible(torneo)
      && checked.isRevealed(torneo, checked.now) === true,
  );
  if (!visible.length) return [];
  const ids = visible.map((torneo) => positiveId(torneo.id));
  if (ids.some((id) => !id)) throw error('Un torneo publicado tiene una identidad inválida.');

  const [equiposResult, puntosResult] = await Promise.all([
    db.from('equipos').select('id,torneo_id').in('torneo_id', ids),
    db.from('tabla_puntos').select('torneo_id,equipo_id,posicion,puntos').in('torneo_id', ids),
  ]);
  if ([equiposResult, puntosResult].some((result) => result?.error || !Array.isArray(result?.data))) {
    throw error('No se pudieron comprobar los puntos y selecciones publicados.', 'NATIONS_COUNTRY_RANKING_UNAVAILABLE', 503);
  }
  return buildNationsCountryRanking(
    { torneos: visible, equipos: equiposResult.data, puntos: puntosResult.data },
    checked,
  );
}
