const SPORT_WORDS = /(soccer|football|futsal|fútbol|futbol|indoor|multisport|multi-sport|sports? cent|stadium|arena)/i;
const PADEL_WORDS = /(padel|pádel)/i;
// A generic club name is not evidence of a chain or investment capacity.
const CHAIN_WORDS = /(franchise|franquicia|chain|cadena|group|grupo|operator|operador|resort|multisede|multi-sede)/i;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function isPadelOnly(prospect = {}) {
  const text = [prospect.sector, prospect.activities, prospect.facility_notes, prospect.name, prospect.website].filter(Boolean).join(' ');
  return PADEL_WORDS.test(text) && !SPORT_WORDS.test(text);
}

export function gradeFor(score) { return score >= 85 ? 'A' : score >= 65 ? 'B' : 'C'; }

/**
 * Explainable 0-100 score. Every point records whether it is evidenced or
 * inferred; missing data never invents evidence.
 */
export function scoreProspect(prospect = {}, weights = {}) {
  const w = {sport:25, investment:20, facilities:15, locations:10, compatibility:10, representation:10, franchise:5, contactability:5, activity:5, ...weights};
  const evidence = prospect.data_status || {};
  const text = [prospect.sector, prospect.activities, prospect.facility_notes, prospect.name].filter(Boolean).join(' ');
  const padelOnly = prospect.is_padel_only === true || isPadelOnly(prospect);
  const sport = SPORT_WORDS.test(text) ? 'confirmed' : 'inferred';
  const locations = Number(prospect.locations_count || 1);
  const chain = CHAIN_WORDS.test(text) || locations > 1;
  const hasEmail = Boolean(prospect.email);
  const hasPhone = Boolean(prospect.phone);
  const hasWebsite = Boolean(prospect.website);
  const rows = [];
  const add = (key, label, points, max, source, inferred = false) => {
    if (!max) return;
    rows.push({key, label, points: clamp(Math.round(points), 0, max), max, source, inferred});
  };
  add('sport', 'Afinidad con fútbol y deportes compatibles', padelOnly ? 0 : w.sport * (sport === 'confirmed' ? 1 : 0.55), w.sport, sport === 'confirmed' ? 'Etiquetas de actividad / deporte' : 'Inferencia por nombre o categoría', sport !== 'confirmed');
  add('investment', 'Capacidad aparente de inversión', padelOnly ? 0 : w.investment * (chain ? 1 : 0.55), w.investment, chain ? 'Cadena, grupo u operador' : 'Sin evidencia de escala', !chain);
  add('facilities', 'Instalaciones y expansión', padelOnly ? 0 : w.facilities * (prospect.facility_notes ? 0.8 : prospect.address ? 0.35 : 0), w.facilities, prospect.facility_notes ? 'Notas públicas de instalaciones' : prospect.address ? 'Dirección pública; sin notas de instalaciones' : 'Sin dirección ni instalaciones', !prospect.facility_notes);
  add('locations', 'Cantidad de sedes', w.locations * (locations > 1 ? 1 : 0.35), w.locations, 'Dato de sedes', locations <= 1);
  add('compatibility', 'Compatibilidad con Sistema Padbol', padelOnly ? 0 : w.compatibility * (SPORT_WORDS.test(text) ? 1 : 0.45), w.compatibility, 'Actividad declarada', !SPORT_WORDS.test(text));
  add('representation', 'Potencial de representación territorial', padelOnly ? 0 : w.representation * (chain ? 0.8 : 0.35), w.representation, 'Escala / cadena', !chain);
  add('franchise', 'Potencial de franquicia', padelOnly ? 0 : w.franchise * (CHAIN_WORDS.test(text) ? 1 : 0.35), w.franchise, 'Modelo de cadena', !CHAIN_WORDS.test(text));
  add('contactability', 'Contacto comercial verificable', w.contactability * (hasEmail ? 1 : hasPhone || hasWebsite ? 0.6 : 0), w.contactability, hasEmail ? 'Correo público' : hasPhone ? 'Teléfono público' : hasWebsite ? 'Sitio web público' : 'Sin contacto público', !hasEmail);
  add('activity', 'Evidencia de actividad y crecimiento', w.activity * (hasWebsite ? 0.8 : 0.25), w.activity, hasWebsite ? 'Sitio web activo' : 'Sin evidencia', !hasWebsite);
  const raw = rows.reduce((sum, row) => sum + row.points, 0);
  const max = Object.values(w).reduce((sum, value) => sum + Number(value || 0), 0) || 1;
  const score = padelOnly ? 0 : clamp(Math.round(raw / max * 100), 0, 100);
  const confirmed = rows.filter(row => !row.inferred).reduce((sum, row) => sum + row.points, 0);
  const inferred = rows.filter(row => row.inferred).reduce((sum, row) => sum + row.points, 0);
  return {
    score, grade: gradeFor(score), breakdown: rows,
    confidence: raw ? Math.round(confirmed / Math.max(1, confirmed + inferred) * 100) : 0,
    excluded: padelOnly, exclusion_reason: padelOnly ? 'Club exclusivamente de pádel: fuera de prospección activa' : null,
  };
}
