/** Explicit restart after a verified reset. Inject existing auth/context/clock
 * helpers; no new permission path. Not mounted as a route. */
export async function restartGamesTracking({pool,authorize,loadContext,clockSnapshot,req,scoreboardId,requestId,epoch}) {
 const fail=code=>{throw Object.assign(new Error(code),{code,status:409});};
 if(!Number.isSafeInteger(epoch)||epoch<1||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId||''))fail('GAME_RESTART_INPUT_INVALID');
 const actor=await authorize(req,{matchId:scoreboardId});if(!actor?.actorId)fail('GAME_AUTH_CONTEXT_REQUIRED');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0))");
  const row=(await c.query('SELECT * FROM public.scoreboard_partidos WHERE id=$1 FOR UPDATE',[scoreboardId])).rows[0];
  const agg=(await c.query('SELECT * FROM nations_marker_private.nations_marker_match WHERE match_id=$1 FOR UPDATE',[scoreboardId])).rows[0];
  if(!row||!agg)fail('GAME_TRACKING_MISSING');
  if(agg.games_epoch!==epoch)fail('GAME_EPOCH_CONFLICT');
  const previous=agg.receipts?.restart;
  if(previous?.epoch===epoch&&previous?.requestId===requestId&&previous?.actorId===actor.actorId){await c.query('COMMIT');return {epoch,revision:agg.revision,deduplicated:true,refreshRequired:true};}
  if(agg.tracking_status!=='reset_pending')fail('GAME_RESTART_NOT_PENDING');
  if(row.estado!=='pendiente'||row.cronometro_inicio!==null||row.cronometro_pausado||Number(row.cronometro_segundos)!==0||['score_a','score_b','games_a','games_b','sets_a','sets_b'].some(k=>Number(row[k])!==0)||!Array.isArray(row.historial_sets)||row.historial_sets.length)fail('GAME_RESET_BASELINE_INVALID');
  if(agg.games_ledger&&(agg.games_ledger.total!==0||!Array.isArray(agg.games_ledger.active)||agg.games_ledger.active.length))fail('GAME_RESET_LEDGER_INVALID');
  const ctx=await loadContext(c,scoreboardId);const states={};
  const ts=(await c.query('SELECT clock_timestamp() AS ts')).rows[0].ts;
  for(const [team,t] of Object.entries(ctx.teams)){
   const roster=[...t.lineup.iniciales,...t.lineup.suplentes];
   if(t.lineup.iniciales.length!==2||new Set(roster).size!==roster.length)fail('GAME_RESTART_LINEUP_INVALID');
   states[team]={revision:0,status:'open',startedAt:new Date(ts).getTime(),closedAt:null,pausedAt:null,events:[],corrections:[],active:[...t.lineup.iniciales],lineup:{iniciales:[...t.lineup.iniciales],suplentes:[...t.lineup.suplentes]},roster};
  }
  if(Object.keys(states).length!==2)fail('GAME_RESTART_TEAMS_INVALID');
  await c.query('INSERT INTO nations_marker_private.nations_marker_clock_revision(scoreboard_id,revision) VALUES($1,0) ON CONFLICT (scoreboard_id) DO NOTHING',[scoreboardId]);
  const after=(await c.query("UPDATE public.scoreboard_partidos SET cronometro_inicio=$2,cronometro_pausado=false,cronometro_segundos=0,estado='en_curso' WHERE id=$1 RETURNING *",[scoreboardId,ts])).rows[0];
  const clockRev=(await c.query('SELECT revision FROM nations_marker_private.nations_marker_clock_revision WHERE scoreboard_id=$1',[scoreboardId])).rows[0].revision;
  const receipts={__clock:clockSnapshot(after,clockRev),start:{idempotencyKey:requestId,actorId:actor.actorId,startedAt:ts,lineup:Object.fromEntries(Object.entries(ctx.teams).map(([id,t])=>[id,t.lineup.revision]))},restart:{epoch,requestId,actorId:actor.actorId,startedAt:ts}};
  const result=(await c.query("UPDATE nations_marker_private.nations_marker_match SET states=$2,receipts=$3,tracking_status='active',revision=revision+1,updated_at=clock_timestamp() WHERE match_id=$1 RETURNING revision",[scoreboardId,JSON.stringify(states),JSON.stringify(receipts)])).rows[0];
  await c.query('INSERT INTO nations_marker_private.nations_marker_audit(match_id,revision,kind,actor,payload) VALUES($1,$2,$3,$4,$5)',[scoreboardId,result.revision,'restart',actor.actorId,JSON.stringify({eventId:requestId,epoch,startedAt:ts})]);
  await c.query('COMMIT');return {epoch,revision:result.revision,deduplicated:false,refreshRequired:true};
 }catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}
}
