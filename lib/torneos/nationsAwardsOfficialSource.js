import {loadNationsMarkerMatchContext} from './nationsMarkerMatchContext.js';
import {buildNationsPlacements} from './nationsCupService.js';
import {buildSetsParticipation} from './nationsSetsParticipation.js';
import {createHash} from 'node:crypto';

const fail=(code,message)=>Object.assign(new Error(message||code),{code,status:409});
const teamKey=value=>String(value);
function mapStates(raw,membership){const states={};for(const side of ['A','B']){const id=teamKey(membership[side]);const state=raw?.states?.[id]??raw?.states?.[side];if(!state)throw fail('TEAM_STATE_MISSING',`Falta estado oficial del equipo ${id}.`);states[id]=state;}return states;}
function picks(rows){return rows.map(row=>({...row,id:String(row.id),scoreboardId:String(row.scoreboard_id??row.id)}));}

/**
 * Official private source for final awards. Every value comes from DB:
 * finalized scoreboard + completed finalization intent + marker states/games_ledger.
 * No participant counts or positions are accepted from an HTTP body.
 */
export async function loadOfficialNationsAwardParticipants({pool,eventId,plan,matches,loadContext=loadNationsMarkerMatchContext,minimumSets=1,buildPlacements=buildNationsPlacements}){
  if(!pool?.connect)throw fail('AWARDS_POOL_REQUIRED','Falta pool privado.');
  if(!Array.isArray(matches)||!matches.length)throw fail('MATCHES_REQUIRED','Sin partidos oficiales.');
  if(!plan?.qualified?.length)throw fail('PLAN_NOT_FINAL','El plan no tiene clasificación final.');
  const placements=buildPlacements(plan,matches);
  const positionByTeam=new Map(placements.map(p=>[teamKey(p.equipo_id),p.posicion]));
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const ids=matches.map(m=>Number(m.id)).filter(Number.isSafeInteger);
    const {rows}=await client.query(`SELECT DISTINCT ON (s.partido_torneo_id) s.id::text AS scoreboard_id,s.partido_torneo_id,s.torneo_id,s.historial_sets,s.estado AS scoreboard_estado,m.states,m.games_ledger,m.revision,m.games_epoch,i.epoch AS finalization_epoch,i.revision AS finalization_revision,i.status AS finalization_status
      FROM public.scoreboard_partidos s
      JOIN nations_marker_private.nations_marker_match m ON m.match_id=s.id::text
      JOIN nations_marker_private.games_finalization_intents i ON i.scoreboard_id::text=s.id::text AND i.status='completed' AND i.epoch=m.games_epoch
      WHERE s.torneo_id=$1 AND s.partido_torneo_id=ANY($2::bigint[]) AND lower(coalesce(s.estado,'')) IN ('terminado','finalizado')
      ORDER BY s.partido_torneo_id,s.updated_at DESC`,[Number(eventId),ids]);
    if(rows.length!==ids.length)throw fail('FINALIZATION_SOURCE_INCOMPLETE','No todos los partidos tienen finalización oficial completada.');
    const byPlayer=new Map(), teamTotals=new Map();
    const groupMatches=matches.filter(m=>m.grupo&&m.bracket_round==null&&m.estado==='finalizado');
    const winsByTeam=new Map();for(const m of groupMatches){const w=Number(m.ganador_equipo_id);if(Number.isSafeInteger(w)&&w>0)winsByTeam.set(String(w),(winsByTeam.get(String(w))||0)+1);}
    const qualified=new Set((plan.qualified||[]).map(q=>teamKey(q.equipo_id)));
    for(const row of picks(rows)){
      const context=await loadContext({query:(sql,args)=>client.query(sql,args)},row.scoreboard_id);
      const membership=context.membership;
      const aggregate={states:mapStates({states:row.states},membership),revision:Number(row.revision),finalization:{status:row.finalization_status,revision:Number(row.revision)},gamesLedger:row.games_ledger};
      const sets=buildSetsParticipation({aggregate,scoreboard:{historial_sets:Array.isArray(row.historial_sets)?row.historial_sets:null},minimumSets});
      if(String(context.torneoId)!==String(eventId)||String(context.partidoTorneoId)!==String(row.partido_torneo_id))throw fail('CONTEXT_SCOPE_MISMATCH','Contexto de partido fuera del torneo.');
      for(const team of sets.teams){
        const tid=teamKey(team.teamId); const teamInfo=context.teams?.[membership.A===tid?'A':'B']||context.teams?.[tid];
        const teamPlayers=new Set((teamInfo?.players||[]).map(p=>String(p.id)));
        teamTotals.set(tid,(teamTotals.get(tid)||0)+team.teamTotalSets);
        for(const p of team.players){
          if(!teamPlayers.has(String(p.id)))throw fail('PLAYER_CONTEXT_MISMATCH','Jugador fuera del contexto oficial.');
          const prev=byPlayer.get(String(p.id))||{playerId:String(p.id),teamId:tid,playerSets:0};
          prev.playerSets+=p.playerSets;byPlayer.set(String(p.id),prev);
        }
      }
    }
    const maxByTeam=new Map();for(const p of byPlayer.values())maxByTeam.set(p.teamId,Math.max(maxByTeam.get(p.teamId)||0,p.playerSets));
    const awardPosition=pos=>pos>=5&&pos<=8?'QF':pos>=9&&pos<=15?'GS':pos;
    const participants=[...byPlayer.values()].map(p=>{const position=positionByTeam.get(p.teamId);if(!position)throw fail('PLACEMENT_MISSING',`Sin posición final para ${p.teamId}.`);const eliminated=!qualified.has(p.teamId);return {playerId:p.playerId,teamId:p.teamId,position:awardPosition(position),playerSets:p.playerSets,teamTotalSets:teamTotals.get(p.teamId)||0,maxPlayerSets:maxByTeam.get(p.teamId)||0,minimumMet:p.playerSets>=Number(minimumSets),groupWins:eliminated?(winsByTeam.get(p.teamId)||0):0,eliminatedInGroupStage:eliminated,ageYears:0};});
    const sourceDigest=createHash('sha256').update(JSON.stringify({eventId:Number(eventId),planRevision:Number(plan.revision),placements,participants,ledgerRows:rows.map(r=>({id:r.scoreboard_id,revision:r.revision,epoch:r.games_epoch,historial_sets:r.historial_sets})),policy:plan.award_policy??null})).digest('hex');
    await client.query('COMMIT');
    return {participants,placements,sourceRevision:Number(plan.revision),sourceDigest};
  }catch(error){try{await client.query('ROLLBACK')}catch{}throw error;}finally{client.release();}
}
