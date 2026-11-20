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
    // The allowed sede is read from the current tournament, not only the constant.
    const event = await pool.query(
      'SELECT 1 FROM public.torneos WHERE id = $1 AND sede_id = $2 LIMIT 1',
      [NATIONS_TOURNAMENT_ID, Number(sedeId)],
    );
    if (Number(event?.rowCount) !== 1) return false;
    await assertNationsOperatorGrant(pool, userId, NATIONS_TOURNAMENT_ID, { action: 'scoreboard' });
    return true;
  } catch { return false; }
}
export async function isOwnedContingencyScoreboard({ pool, partido, userId }) {
  if (!isIndependentContingencyScoreboard(partido) || !pool || !userId) return false;
  const result = await pool.query(
    'SELECT 1 FROM public.scoreboard_contingency_owners WHERE scoreboard_id = $1 AND user_id = $2 LIMIT 1',
    [partido.id, userId],
  );
  return Number(result?.rowCount) === 1;
}

export function isIndependentContingencyScoreboard(partido) {
  return Boolean(partido) && partido.partido_torneo_id == null && partido.torneo_id == null;
}
