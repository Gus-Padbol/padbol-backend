// Facade de compatibilidad: conserva el contrato Supabase actual y expone
// el contrato bulk transaccional (pool + auth) en un módulo separado.
export * from './scoreboardTorneoLegacyService.js';
export { generarScoreboardsForTorneoBulk } from './scoreboardTorneoBulkService.js';
import { generarScoreboardsForTorneoLegacy } from './scoreboardTorneoLegacyService.js';
import { generarScoreboardsForTorneoBulk } from './scoreboardTorneoBulkService.js';

/** Supabase client => contrato legacy; pg pool => bulk transaccional. */
export async function generarScoreboardsForTorneo(first, torneoId, body = {}, auth) {
  if (first?.from && typeof first.from === 'function') {
    return generarScoreboardsForTorneoLegacy(first, torneoId, body);
  }
  return generarScoreboardsForTorneoBulk(first, torneoId, body, auth);
}
