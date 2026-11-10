/** Called only AFTER existing scoreboard authorization; does not authorize callers.
 * The frontend must preserve requestId for a retry and renew it for a new action.
 * Existing route remains disabled until this is wired and end-to-end validated. */
export async function commitGamesHttpCommand({pool,scoreboardId,actorId,requestId,kind,team,expectedVersion,next,history=null,historyId=null,epoch}) {
 const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if(!Number.isSafeInteger(epoch)||epoch<0)fail('GAME_EPOCH_REQUIRED');
 if(!uuid.test(requestId||''))fail('GAME_REQUEST_ID_REQUIRED');
 if(typeof actorId!=='string'||!actorId.trim())fail('GAME_AUTH_CONTEXT_REQUIRED',403);
 if(!['point','undo','reset','tiebreak'].includes(kind))fail('GAME_COMMAND_INVALID');
 if(kind==='point'&&!['A','B'].includes(team))fail('GAME_TEAM_INVALID');
 if(kind==='point'&&history?.equipo!==team)fail('GAME_HISTORY_TEAM_MISMATCH');
 if(kind==='undo'&&!uuid.test(historyId||''))fail('GAME_UNDO_HISTORY_REQUIRED',409);
 const command={kind,actorId,epoch,...(kind==='point'?{team}:{}),...(kind==='undo'?{historyId}:{})};
 const r=await pool.query('SELECT nations_marker_private.commit_games_command_candidate($1,$2,$3,$4,$5,$6,$7) result',[scoreboardId,requestId,JSON.stringify(command),expectedVersion,JSON.stringify(next),history===null?null:JSON.stringify(history),historyId]);
 if(!r.rows[0]?.result)fail('GAME_VERSION_CONFLICT',409);
 return r.rows[0].result;
}
