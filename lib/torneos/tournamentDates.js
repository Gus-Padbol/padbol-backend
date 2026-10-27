const invalid = message => Object.assign(new Error(message), { status: 400, code: 'TOURNAMENT_DATES_INVALID' });
function dateOnly(value) {
  if (value == null || value === '') return null;
  const text = String(value).slice(0, 10);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw invalid('La fecha del torneo no es válida.');
  }
  return text;
}
export function validateTournamentDates(torneo) {
  const start = dateOnly(torneo?.fecha_inicio);
  const end = dateOnly(torneo?.fecha_fin);
  if (start && end && start > end) throw invalid('La fecha de fin no puede ser anterior a la fecha de inicio.');
  return { start, end };
}
export function tournamentClosureDate(torneo, actualDate) {
  const { start, end } = validateTournamentDates(torneo);
  const actual = dateOnly(actualDate);
  if (start && actual < start) {
    if (torneo.es_prueba === true) return end || start;
    throw Object.assign(new Error('No se puede finalizar un torneo real antes de su fecha de inicio.'), { status: 409, code: 'TOURNAMENT_NOT_STARTED' });
  }
  return actual;
}

export function tournamentLocalDate(torneo, instant) {
  const timezone = torneo?.plan_nations?.config?.timezone || torneo?.timezone || 'America/Argentina/Buenos_Aires';
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map(p => [p.type,p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
