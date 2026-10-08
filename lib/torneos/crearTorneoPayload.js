import { resolvePartidoSportFormat } from '../partidoSportFormat.js';

/** Preserve the existing create fields; validate the two sport/format additions. */
export function buildCrearTorneoPayload(body, authUserId) {
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
    sede_id: sedeId,
    nivel_torneo: body.nivel_torneo,
    tipo_torneo: body.tipo_torneo,
    estado: 'planificacion',
    fecha_inicio: body.fecha_inicio,
    fecha_fin: body.fecha_fin,
    cantidad_equipos: body.cantidad_equipos,
    es_multisede: body.es_multisede,
    created_by: authUserId,
    deporte: format.deporte,
    formato_equipo: format.formato_juego === '1v1' ? 'singles' : 'dobles',
  };
}
