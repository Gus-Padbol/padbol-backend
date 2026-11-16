/** Future-only, parameterized Nations award calculation. No DB writes here. */
export const TOUR500_POINTS = Object.freeze({1:500,2:300,3:190,4:170,QF:90,R16:45,GS:20});
export const TOUR500_GS_BONUS = 3;
export const ANNUAL_COEFFICIENTS = Object.freeze([1,0.5,0.25,0.1,0.05,0.01]);
export const DENOMINATOR_MODES = Object.freeze(['team_total_sets','max_player_sets']);
export const BONUS_PRORATION_MODES = Object.freeze(['none','participation_factor']);

const fail=(code,message)=>Object.assign(new Error(message),{code,status:409});
const int=(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={})=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw fail('INVALID_'+label,String(label));return n;};

/** Explicit denominator; no default. Zero denominator is zero, never 50%. */
export function participationFactor({unit='sets',playerCount,denominator,minimumMet=true}) {
  if (unit !== 'sets') throw fail('UNIT_NOT_SETS','La unidad confirmada es sets jugados.');
  const p=int(playerCount,'PLAYER_SETS'), d=int(denominator,'DENOMINATOR');
  if (d===0) return 0;
  if (!minimumMet) return 0;
  if (p===0) return 0;
  return p/d >= 0.5 ? 1 : 0.5;
}

export function resolveDenominator({mode,teamTotalSets,maxPlayerSets}) {
  if (!DENOMINATOR_MODES.includes(mode)) throw fail('DENOMINATOR_MODE_REQUIRED','Falta decidir denominador team total sets vs max player sets.');
  return mode==='team_total_sets' ? int(teamTotalSets,'TEAM_TOTAL_SETS') : int(maxPlayerSets,'MAX_PLAYER_SETS');
}

export function awardKey(eventId,playerId){if(!eventId||!playerId)throw fail('AWARD_KEY_REQUIRED','event/player requeridos');return `${eventId}:${playerId}`;}

/** Final position only; bonus only for GS-eliminated teams and never silently prorated. */
export function computeAward({eventId,playerId,position,definitive,playerSets,teamTotalSets,maxPlayerSets,denominatorMode,minimumMet=true,groupWins=0,eliminatedInGroupStage=false,bonusProration='none',ageYears=0}) {
  if(!definitive)throw fail('NOT_FINAL','El premio sólo se calcula al cierre oficial.');
  const base=TOUR500_POINTS[position];if(base==null)throw fail('INVALID_POSITION','Posición inválida.');
  if(!BONUS_PRORATION_MODES.includes(bonusProration))throw fail('BONUS_MODE_REQUIRED','Modo de prorrateo del bonus inválido.');
  const denominator=resolveDenominator({mode:denominatorMode,teamTotalSets,maxPlayerSets});
  const factor=participationFactor({playerCount:playerSets,denominator,minimumMet});
  const coefficient=ANNUAL_COEFFICIENTS[int(ageYears,'AGE_YEARS',{max:5})];
  let bonus=0;
  if(eliminatedInGroupStage){bonus=int(groupWins,'GROUP_WINS')*TOUR500_GS_BONUS;if(bonusProration==='participation_factor')bonus*=factor;}
  else if(groupWins>0)throw fail('BONUS_ONLY_GS','El bonus sólo aplica a eliminados en fase de grupos.');
  return {ok:true,key:awardKey(eventId,playerId),base,factor,bonus,coefficient,points:(base*factor+bonus)*coefficient,denominatorMode,denominator,policy:{unit:'sets',minimumMet,bonusProration,rounding:'none'}};
}

/** In-memory idempotency: first event:player wins; corrected source can replace only with same key. */
export function applyAwards(existing,awards){const map=new Map(existing??[]);for(const award of awards??[]){if(!award?.ok)continue;if(map.has(award.key))continue;map.set(award.key,award);}return map;}
