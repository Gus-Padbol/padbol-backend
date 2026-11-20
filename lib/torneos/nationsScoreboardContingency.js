'use strict';
import { assertNationsOperatorGrant } from './nationsOperatorAccess.js';
/**
 * Scoped contingency capability: an active Nations 57 operator grant may create
 * independent scoreboards only for the tournament's own sede. Never a global role.
 */
export const NATIONS_TOURNAMENT_ID = 57;
export const NATIONS_CONTINGENCY_SEDE_ID = 9;

export const GIACOMO_CONTINGENCY_USER_ID = '80838a2c-d465-4b39-b7a3-c32984e77791';
export async function canManageNationsContingencyScoreboard({ pool, userId, sedeId }) {
  if (!pool || userId !== GIACOMO_CONTINGENCY_USER_ID) return false;
  if (Number(sedeId) !== NATIONS_CONTINGENCY_SEDE_ID) return false;
  try {
    await assertNationsOperatorGrant(pool, userId, NATIONS_TOURNAMENT_ID, { action: 'scoreboard' });
    return true;
  } catch { return false; }
}
export function isOwnedContingencyScoreboard(partido, userId) {
  return isIndependentContingencyScoreboard(partido) && String(partido?.created_by_user_id || '') === String(userId || '');
}

export function isIndependentContingencyScoreboard(partido) {
  return Boolean(partido) && partido.partido_torneo_id == null && partido.torneo_id == null;
}
