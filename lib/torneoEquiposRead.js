/**
 * Decide qué devuelve GET /api/torneos/:id/equipos.
 * Reglas:
 *  - Con audiencia Nations y no admin: el capitán ve su equipo completo; el resto, proyección
 *    mínima (id, nombre, grupo, posición) y solo si la revelación está habilitada.
 *  - Sin audiencia: si el acceso es por capitán, solo sus equipos; si está sellado, nada;
 *    público revelado y torneo normal conservan la lista.
 *  - Admin del torneo: lista completa.
 */
export function decidirPayloadEquipos({result, audience, enrollmentAdmin, gate, capitanIds}) {
  if (audience && !audience.admin) {
    return result
      .map((eq) => (audience.captainIds.includes(Number(eq.id)) ? eq : {id: eq.id, nombre: eq.nombre, grupo: eq.grupo, posicion: eq.posicion}))
      .filter((eq) => audience.revealed || audience.captainIds.includes(Number(eq.id)));
  }
  if (!audience && gate?.reason === 'captain') {
    return result.filter((eq) => capitanIds.includes(Number(eq.id)));
  }
  if (!audience && !enrollmentAdmin && gate?.reason === 'sealed') return [];
  return result;
}
