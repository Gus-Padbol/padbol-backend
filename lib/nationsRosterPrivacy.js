/**
 * Frontera única de autorización de planteles para torneos de selecciones (Nations).
 * Regla: nadie ve planteles ajenos salvo admin del torneo o capitán dueño del equipo.
 * El público solo ve CON aprobación explícita de publicación Y fecha de revelación cumplida.
 * Fail-closed: modalidad_plantel='selecciones' cuenta como Nations aunque plan_nations sea NULL.
 */
export function esSelecciones(torneo) {
  return Boolean(torneo)
    && (torneo.modalidad_plantel === 'selecciones' || torneo.plan_nations != null);
}

export function revelacionCumplida(torneo, ahora = new Date()) {
  const horas = Number(torneo?.horas_revelar_equipos);
  const inicio = torneo?.fecha_inicio ? new Date(`${torneo.fecha_inicio}T00:00:00Z`) : null;
  if (!inicio || !Number.isFinite(horas)) return false;
  return ahora.getTime() >= inicio.getTime() - horas * 3600 * 1000;
}

export function publicoPuedeVerPlanteles({torneo, aprobado, ahora = new Date()}) {
  if (!esSelecciones(torneo)) return true;
  return aprobado === true && revelacionCumplida(torneo, ahora);
}

/**
 * @returns {{verPlantel: boolean, verEquipo: boolean, verCatalogo: boolean, motivo: string}}
 */
export function autorizacionPlanteles({torneo, aprobado = false, esAdmin = false, esCreador = false, esCapitan = false, ahora = new Date()}) {
  if (!esSelecciones(torneo)) return {verPlantel: true, verEquipo: true, verCatalogo: true, motivo: 'torneo_normal'};
  if (esAdmin) return {verPlantel: true, verEquipo: true, verCatalogo: true, motivo: 'admin'};
  if (esCreador || esCapitan) return {verPlantel: true, verEquipo: true, verCatalogo: false, motivo: 'scope_equipo'};
  if (publicoPuedeVerPlanteles({torneo, aprobado, ahora})) {
    return {verPlantel: true, verEquipo: true, verCatalogo: true, motivo: 'publicado'};
  }
  return {verPlantel: false, verEquipo: false, verCatalogo: false, motivo: 'sellado'};
}
