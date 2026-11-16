import {createHash} from 'node:crypto';
import {computeAward} from './nationsAwardsFinal.js';
/** Build final award ledger rows from official, already-finalized participation. No DB here. */
export function buildFinalAwardRows({eventId, sourceRevision, sourceDigest = null, definitive, participants, policy}) {
  if (!definitive) throw Object.assign(new Error('El torneo debe estar cerrado oficialmente.'), {code:'AWARDS_NOT_FINAL'});
  if (!Number.isSafeInteger(Number(sourceRevision)) || Number(sourceRevision) < 0) throw Object.assign(new Error('sourceRevision requerida.'), {code:'SOURCE_REVISION_REQUIRED'});
  if (!Array.isArray(participants)) throw Object.assign(new Error('participants requerido.'), {code:'PARTICIPANTS_REQUIRED'});
  const seen = new Set();
  const rows = participants.map(p => {
    if (!p.playerName || !String(p.playerName).trim()) throw Object.assign(new Error('playerName verificado requerido.'), {code:'PLAYER_NAME_REQUIRED'});
    if (seen.has(String(p.playerId))) throw Object.assign(new Error('player repetido.'), {code:'PLAYER_DUPLICATE'});
    seen.add(String(p.playerId));
    const award = computeAward({eventId, playerId:p.playerId, position:p.position, definitive:true, playerSets:p.playerSets, teamTotalSets:p.teamTotalSets, maxPlayerSets:p.maxPlayerSets, denominatorMode:policy.denominatorMode, minimumMet:p.minimumMet, groupWins:p.groupWins, eliminatedInGroupStage:p.eliminatedInGroupStage, bonusProration:policy.bonusProration, ageYears:p.ageYears});
    const row={...award,playerId:String(p.playerId),playerName:String(p.playerName).trim(),position:String(p.position),sourceRevision:Number(sourceRevision),source:'official_games_ledger'};row.sourceDigest=sourceDigest||createHash('sha256').update(JSON.stringify(row)).digest('hex');return row;
  });
  return {eventId:Number(eventId), sourceRevision:Number(sourceRevision), policy:{...policy}, rows};
}
export async function persistFinalAwards(db, payload) {
  const {data,error}=await db.rpc('guardar_nations_awards',{p_torneo_id:payload.eventId,p_payload:payload});
  if(error)throw error;if(data?.ok!==true)throw Object.assign(new Error('Awards sin confirmación.'),{code:'AWARDS_UNCONFIRMED'});return data;
}
