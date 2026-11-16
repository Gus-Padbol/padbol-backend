/**
 * Future-only Tour 500 award pipeline. Pure preview/build; no DB writes.
 * The participation unit (time|sets) and 6-game/one-set minimum remain configuration supplied by ROOT.
 */
export const TOUR500_POSITION_POINTS = Object.freeze({1:500,2:300,3:190,4:170,QF:90,R16:45,GS:20});
export const TOUR500_GS_WIN_BONUS = 3;
export const TOUR500_COEFFICIENTS = Object.freeze([1,0.5,0.25,0.1,0.05,0.01]);

export function awardKey(eventId, playerId) {
  if (!eventId || !playerId) throw new Error('AWARD_KEY_REQUIRED');
  return `${String(eventId)}:${String(playerId)}`;
}

/** time/sets are deliberately supplied by the caller; this helper does not choose a unit. */
export function participationFactor({ unit, player, team, minimumMet = true }) {
  if (!['time', 'sets'].includes(unit)) throw new Error('PARTICIPATION_UNIT_REQUIRED');
  const p = Number(player), t = Number(team);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t < 0 || p < 0 || p > t) throw new Error('INVALID_PARTICIPATION');
  if (t === 0) return 0; // zero team play => zero, per Gus; minimum handled by caller
  if (!minimumMet) return 0;
  return p / t >= 0.5 ? 1 : 0.5;
}

/** Final position only. A normal match win is never a 500 award. */
export function previewAward({ eventId, playerId, position, definitive = false, unit, player, team, minimumMet = true, ageYears = 0, eliminatedInGroupStage = false, groupWins = 0, bonusProration = 'none' }) {
  if (!definitive) return { ok:false, code:'NOT_DEFINITIVE' };
  if (TOUR500_POSITION_POINTS[position] == null) return { ok:false, code:'INVALID_POSITION' };
  if (!Number.isSafeInteger(Number(groupWins)) || Number(groupWins) < 0) return { ok:false, code:'INVALID_GROUP_WINS' };
  if (!Number.isSafeInteger(Number(ageYears)) || Number(ageYears) < 0 || Number(ageYears) >= TOUR500_COEFFICIENTS.length) return { ok:false, code:'INVALID_AGE' };
  const factor = participationFactor({ unit, player, team, minimumMet });
  const base = TOUR500_POSITION_POINTS[position] * factor;
  let bonus = 0;
  if (eliminatedInGroupStage) {
    if (bonusProration === 'none') bonus = Number(groupWins) * TOUR500_GS_WIN_BONUS;
    else if (bonusProration === 'factor') bonus = Number(groupWins) * TOUR500_GS_WIN_BONUS * factor;
    else return { ok:false, code:'BONUS_PRORATION_UNRESOLVED' };
  } else if (groupWins) return { ok:false, code:'BONUS_ONLY_GS_ELIMINATED' };
  const coefficient = TOUR500_COEFFICIENTS[Number(ageYears)];
  return { ok:true, key:awardKey(eventId,playerId), base, bonus, coefficient, points: (base + bonus) * coefficient, source:'TOUR500_FINAL_POSITION' };
}

/** Idempotent in-memory application used by tests/preview; no writes. */
export function applyAwards(existing, awards) {
  const next = new Map(existing ?? []);
  const applied = [];
  for (const award of awards ?? []) {
    if (!award?.ok) continue;
    if (next.has(award.key)) continue;
    next.set(award.key, award);
    applied.push(award.key);
  }
  return { next, applied };
}
