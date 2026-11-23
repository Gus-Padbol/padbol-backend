import { validateTournamentDates } from './tournamentDates.js';
import { validateRosterMode } from '../nationalTeamLineup.js';
import { resolvePartidoSportFormat } from '../partidoSportFormat.js';

function optionalMoney(value, field) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`${field} inválido`), { status: 400, code: 'TOURNAMENT_MONEY_INVALID' });
  }
  return n;
}

function optionalCapacity(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 2) {
    throw Object.assign(new Error('La capacidad debe ser un entero de al menos 2.'), { status: 400, code: 'TOURNAMENT_CAPACITY_INVALID' });
  }
  return n;
}

function optionalOpeningDate(value) {
  if (value == null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error('Fecha de apertura de inscripción inválida'), { status: 400, code: 'TOURNAMENT_OPENING_DATE_INVALID' });
  }
  return date.toISOString();
}

function optionalText(value, max = 500) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw Object.assign(new Error('Texto de premios demasiado largo'), { status: 400, code: 'TOURNAMENT_PRIZES_INVALID' });
  return text;
}

/** Preserve create fields and persist the inscription money/capacity/opening/prizes contract. */
export function buildCrearTorneoPayload(body, authUserId) {
  validateTournamentDates(body);
  const format = resolvePartidoSportFormat({ deporte: body.deporte, formato_equipo: body.formato_equipo });
  const sedeId = body.sede_id == null || body.sede_id === '' ? null : Number(body.sede_id);
  if (sedeId != null && (!Number.isSafeInteger(sedeId) || sedeId <= 0)) {
    throw Object.assign(new Error('Sede inválida'), { status: 400 });
  }
  if (body.es_multisede === true && sedeId != null) {
    throw Object.assign(new Error('Un torneo multisede no puede tener una sede única'), { status: 400 });
  }
  return {
    nombre: body.nombre,
    modalidad_plantel: validateRosterMode(body),
    sede_id: sedeId,
    nivel_torneo: body.nivel_torneo,
    tipo_torneo: body.tipo_torneo,
    estado: 'planificacion',
    fecha_inicio: body.fecha_inicio,
    fecha_fin: body.fecha_fin,
    cantidad_equipos: body.cantidad_equipos,
    inscripcion_monto: optionalMoney(body.inscripcion_monto, 'Monto de inscripción'),
    cupos_maximos: optionalCapacity(body.cupos_maximos),
    premios_descripcion: optionalText(body.premios_descripcion),
    fecha_apertura_inscripcion: optionalOpeningDate(body.fecha_apertura_inscripcion),
    es_multisede: body.es_multisede,
    created_by: authUserId,
    deporte: format.deporte,
    formato_equipo: format.formato_juego === '1v1' ? 'singles' : 'dobles',
  };
}
