import {randomUUID} from 'node:crypto';
import {finalizarPartidoTorneo} from './finalizarPartidoTorneoService.js';
import {onPartidoTorneoFinalizado} from './partidoTorneoFinalizadoEffectsService.js';
import {completeTournamentFromFinalScoreboard} from './tournamentCompletionService.js';
const blocked=reason=>({status:'blocked',reason});
const pending=reason=>({status:'pending',reason});
const SCORE_KEYS=['estado','sets_a','sets_b','games_a','games_b','score_a','score_b','historial_sets'];
export function matchesFinalizationSnapshot(intent,row,epoch){
 const s=intent.final_snapshot;
 return Boolean(s&&row&&epoch===intent.epoch&&String(row.id)===String(intent.scoreboard_id)
  &&['partido_torneo_id','torneo_id','sede_id'].every(k=>String(row[k])===String(s[k]))
  &&SCORE_KEYS.every(k=>JSON.stringify(row[k])===JSON.stringify(s[k])));
}
/** Existing Nations RPC verifies result AND persisted participation on every retry.
 * We do not infer successful finalization from the scoreboard sync flag. */
export async function applyNationsFinalization({db,intent,finalize=finalizarPartidoTorneo,effects=onPartidoTorneoFinalizado,close=completeTournamentFromFinalScoreboard,verify=async()=>true}){
 const s=intent.final_snapshot;
 const result={goles_a:s.sets_a,goles_b:s.sets_b,historial_sets:s.historial_sets};
 if(!await verify())return pending('RECOVERY_LEASE_OR_CONTEXT_CHANGED');
 const finalized=await finalize(db,{partidoId:intent.partido_torneo_id,torneoId:s.torneo_id,resultado:result,context:{fuente:'scoreboard'}});
 if(!finalized?.ok||!['finalized','idempotent'].includes(finalized.status))return pending('FINALIZATION_UNCONFIRMED');
 // Preserve the event timestamp across retries/month boundaries. The point's
 // transaction supplied occurred_at; a late worker must not replace it with now.
 // The legacy result-sync trigger can stamp retry time during finalize().
 // The durable final-point event is authoritative, even across month boundaries.
 if(!await verify())return pending('RECOVERY_LEASE_OR_CONTEXT_CHANGED');
 let update=db.from('scoreboard_partidos').update({sync_torneo_status:'synced',synced_to_torneo_at:new Date(intent.occurred_at).toISOString()}).eq('id',intent.scoreboard_id);
 for(const key of ['partido_torneo_id','torneo_id','sede_id',...SCORE_KEYS])update=update.eq(key,key==='historial_sets'?JSON.stringify(s[key]):s[key]);
 const {data:changed,error}=await update.select('id').maybeSingle();
 if(error)throw error;
 if(!changed)return blocked('FINALIZATION_CONTEXT_CHANGED');
 if(!await verify())return pending('RECOVERY_LEASE_OR_CONTEXT_CHANGED');
 const out=await effects(db,{partidoId:intent.partido_torneo_id,torneoId:s.torneo_id,fuente:'scoreboard',resultado:result});
 if(out?.ok!==true)return pending('BRACKET_EFFECTS_UNCONFIRMED');
 const advance=out.advance;
 if(advance?.status==='skipped'&&advance.reason==='fase_grupos')return {status:'completed',reason:'GROUP_RESULT_CONFIRMED'};
 if(advance?.status==='skipped'&&advance.reason==='no_destino'){
  if(!await verify())return pending('RECOVERY_LEASE_OR_CONTEXT_CHANGED');
  const closure=await close(db,{scoreboardId:intent.scoreboard_id,partidoId:intent.partido_torneo_id});
  if(['completed','idempotent'].includes(closure?.status))return {status:'completed',reason:'TOURNAMENT_CLOSED'};
  if(closure?.reason==='national_explicit_atomic_closure_required')return blocked('NATIONAL_EXPLICIT_CLOSURE_REQUIRED');
  return pending('TOURNAMENT_CLOSURE_UNCONFIRMED');
 }
 if(advance?.status==='advanced'||(advance?.status==='skipped'&&advance.reason==='ya_avanzado')){
  const next=out.scoreboard;
  if(next?.status==='created'||(next?.status==='skipped'&&next.reason==='scoreboard_existente'))return {status:'completed',reason:'NEXT_SCOREBOARD_CONFIRMED'};
  return pending(next?.status==='pending_lineups'?'NEXT_LINEUPS_REQUIRED':'NEXT_SCOREBOARD_PENDING');
 }
 return pending('ADVANCE_UNCONFIRMED');
}
/** Claim one durable intent. No scoreboard locks are held over connector calls.
 * Leases recover killed processes; downstream effects must be idempotent. */
export async function recoverOneGamesFinalization({pool,db,scoreboardId=null,apply=applyNationsFinalization,leaseSeconds=120}){
 if(!Number.isInteger(leaseSeconds)||leaseSeconds<30||leaseSeconds>600)throw Error('INVALID_RECOVERY_LEASE');
 const token=randomUUID();
 const claimed=await pool.query(`WITH chosen AS (
  SELECT scoreboard_id,epoch,effect_kind FROM nations_marker_private.games_finalization_intents
  WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())
   AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND ($1::uuid IS NULL OR scoreboard_id=$1)
  ORDER BY COALESCE(next_attempt_at,occurred_at),occurred_at FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE nations_marker_private.games_finalization_intents i SET lease_token=$2,lease_until=clock_timestamp()+$3*interval '1 second',attempts=attempts+1
 FROM chosen c WHERE i.scoreboard_id=c.scoreboard_id AND i.epoch=c.epoch AND i.effect_kind=c.effect_kind RETURNING i.*`,[scoreboardId,token,leaseSeconds]);
 const intent=claimed.rows[0];if(!intent)return {status:'idle'};
 let outcome;
 try{
  const current=await pool.query(`SELECT s.id,s.partido_torneo_id,s.torneo_id,s.sede_id,s.estado,s.sets_a,s.sets_b,s.games_a,s.games_b,s.score_a,s.score_b,s.historial_sets,m.games_epoch FROM public.scoreboard_partidos s JOIN nations_marker_private.nations_marker_match m ON m.match_id=s.id::text WHERE s.id=$1`,[intent.scoreboard_id]);
  const row=current.rows[0];
  const verify=async()=>{
   const check=await pool.query(`SELECT s.id,s.partido_torneo_id,s.torneo_id,s.sede_id,s.estado,s.sets_a,s.sets_b,s.games_a,s.games_b,s.score_a,s.score_b,s.historial_sets,m.games_epoch FROM public.scoreboard_partidos s JOIN nations_marker_private.nations_marker_match m ON m.match_id=s.id::text JOIN nations_marker_private.games_finalization_intents i ON i.scoreboard_id=s.id AND i.epoch=m.games_epoch WHERE s.id=$1 AND i.lease_token=$2 AND i.lease_until>clock_timestamp() AND i.status='pending'`,[intent.scoreboard_id,token]);
   const current=check.rows[0];return matchesFinalizationSnapshot(intent,current,current?.games_epoch);
  };
  outcome=matchesFinalizationSnapshot(intent,row,row?.games_epoch)?await apply({db,intent,verify}):blocked('FINALIZATION_CONTEXT_CHANGED');
 }catch(error){
  const code=/^[A-Z0-9_]{2,64}$/.test(error?.code||'')?error.code:'UNKNOWN';
  outcome=([401,403].includes(error?.status)||['42P01','42703','42501'].includes(code)?blocked:pending)('RECOVERY_'+code);
 }
 const status=['pending','completed','blocked'].includes(outcome?.status)?outcome.status:'pending';
 const saved=await pool.query(`UPDATE nations_marker_private.games_finalization_intents SET status=$4,last_error=$5,lease_token=NULL,lease_until=NULL,next_attempt_at=CASE WHEN $4='pending' THEN clock_timestamp()+interval '30 seconds' ELSE NULL END WHERE scoreboard_id=$1 AND epoch=$2 AND effect_kind='tournament_finalization' AND lease_token=$3 AND lease_until>clock_timestamp() RETURNING status`,[intent.scoreboard_id,intent.epoch,token,status,outcome?.reason||'FINALIZATION_UNCONFIRMED']);
 return saved.rows[0]?{status,reason:outcome?.reason,scoreboardId:intent.scoreboard_id}:{status:'lease_lost'};
}
/** Runtime-owned lifecycle: no automation, public receiver, or provider is added. */
export function startGamesFinalizationRecovery({pool,db,enabled=false,intervalMs=30000,onResult=()=>{},recover=recoverOneGamesFinalization}){
 if(!enabled)return ()=>{};
 if(!pool||!db||!Number.isInteger(intervalMs)||intervalMs<1000)throw Error('INVALID_RECOVERY_RUNTIME');
 let running=false,stopped=false;
 const tick=async()=>{if(running||stopped)return;running=true;try{const result=await recover({pool,db});if(result.status!=='idle')onResult(result);}catch{onResult({status:'pending',reason:'RECOVERY_STORE_UNAVAILABLE'});}finally{running=false;}};
 const timer=setInterval(tick,intervalMs);timer.unref?.();void tick();
 return ()=>{stopped=true;clearInterval(timer);};
}
