import {commitGamesHttpCommand} from './nationsGamesHttpCommandCandidate.js';
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status});};
/** Existing authorization runs before entering this transaction. prepare executes
 * only for a new request, with the locked scoreboard, never for a retry. */
export async function runGamesMutation({pool,scoreboardId,actorId,requestId,epoch,kind,team,prepare,authorizeLocked}){
 if(typeof authorizeLocked!=='function')fail('GAME_AUTH_CONTEXT_REQUIRED',403);
 if(!pool?.connect)fail('GAME_STORE_UNAVAILABLE',503);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId||''))fail('GAME_REQUEST_ID_REQUIRED',400);
 if(!Number.isSafeInteger(epoch)||epoch<0)fail('GAME_EPOCH_REQUIRED',400);
 if(typeof actorId!=='string'||!actorId.trim())fail('GAME_AUTH_CONTEXT_REQUIRED',403);
 if(!['point','undo','reset'].includes(kind)||kind==='point'&&!['A','B'].includes(team))fail('GAME_COMMAND_INVALID',400);
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0))");
  const row=(await c.query('SELECT * FROM public.scoreboard_partidos WHERE id=$1 FOR UPDATE',[scoreboardId])).rows[0];
  if(!row)fail('GAME_TRACKING_MISSING');
  await authorizeLocked(row);
  const agg=(await c.query('SELECT games_epoch, tracking_status FROM nations_marker_private.nations_marker_match WHERE match_id=$1 FOR UPDATE',[scoreboardId])).rows[0];
  if(!row||!agg)fail('GAME_TRACKING_MISSING');
  const receipt=(await c.query('SELECT command, result FROM nations_marker_private.games_command_receipts WHERE scoreboard_id=$1 AND request_id=$2',[scoreboardId,requestId])).rows[0];
  const same=receipt&&receipt.command.kind===kind&&receipt.command.actorId===actorId&&receipt.command.epoch===epoch&&(kind!=='point'||receipt.command.team===team);
  const resetReplay=kind==='reset'&&same&&agg.tracking_status==='reset_pending'&&agg.games_epoch===epoch+1;
  if(agg.games_epoch!==epoch&&!resetReplay)fail('GAME_EPOCH_CONFLICT');
  if(agg.tracking_status!=='active'&&!resetReplay)fail('GAME_TRACKING_RESTART_REQUIRED');
  if(receipt){
   if(!same)fail('GAME_REQUEST_KEY_REUSED');
   // Return current state, not the old receipt snapshot; undo history may be gone.
   await c.query('COMMIT');return {row,deduplicated:true,gamesEpoch:agg.games_epoch,trackingStatus:agg.tracking_status};
  }
  const expectedVersion=row.updated_at;
  const prepared=await prepare(structuredClone(row),c);
  const result=await commitGamesHttpCommand({pool:c,scoreboardId,actorId,requestId,epoch,kind,team,expectedVersion,...prepared});
  await c.query('COMMIT');return {row:result,deduplicated:false,gamesEpoch:result.gamesEpoch,trackingStatus:result.trackingStatus};
 }catch(error){try{await c.query('ROLLBACK');}catch{}throw error;}finally{c.release();}
}
