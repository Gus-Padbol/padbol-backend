/**
 * Privacidad de planteles de torneo.
 * Regla: un torneo de selecciones (Nations) nunca expone planteles antes de la revelación
 * Y de la aprobación explícita de publicación del roster. El fallback es CERRAR (fail-closed),
 * incluso si plan_nations todavía es NULL.
 */
export const NATIONS_SECRECY_ERROR = 'NATIONS_REVEAL_PENDING';

export function esTorneoSelecciones(torneo) {
  return Boolean(torneo) && (torneo.modalidad_plantel === 'selecciones' || torneo.plan_nations != null);
}

export function revelacionNations(torneo) {
  const horas = Number(torneo?.horas_revelar_equipos);
  const inicio = torneo?.fecha_inicio ? new Date(`${torneo.fecha_inicio}T00:00:00Z`) : null;
  if (!inicio || !Number.isFinite(horas)) return null;
  return new Date(inicio.getTime() - horas * 3600 * 1000);
}

/**
 * @returns {{allowed: boolean, reason: 'admin'|'captain'|'revealed'|'sealed'|'normal'}}
 */
export function accesoPlantelesTorneo({torneo, event, esAdmin, captainIds = [], ahora = new Date()}) {
  if (!esTorneoSelecciones(torneo)) return {allowed: true, reason: 'normal'};
  if (esAdmin) return {allowed: true, reason: 'admin'};
  if (Array.isArray(captainIds) && captainIds.length) return {allowed: true, reason: 'captain'};
  const aprobado = event?.roster_publication_approved === true;
  const reveladoEn = revelacionNations(torneo);
  const revelado = aprobado && reveladoEn != null && ahora.getTime() >= reveladoEn.getTime();
  return revelado ? {allowed: true, reason: 'revealed'} : {allowed: false, reason: 'sealed'};
}
