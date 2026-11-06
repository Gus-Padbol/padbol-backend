// Sede de torneo: existe para alojar un evento, no para reservas por hora.
export const SEDE_TIPO_RESERVABLE = 'reservable';
export const SEDE_TIPO_TORNEO = 'torneo';

export function esSedeTorneo(tipoSede) {
  return String(tipoSede || '').trim().toLowerCase() === SEDE_TIPO_TORNEO;
}

export function errorSedeNoReservable() {
  return { status: 409, code: 'SEDE_NO_RESERVABLE', error: 'Esta sede es de torneo y no admite reservas por hora.' };
}
