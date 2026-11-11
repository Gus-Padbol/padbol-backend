import { createWatchSession, claimWatchSession, resolveWatchSession, revokeWatchSession } from './scoreboardWatchSessionService.js';
import { parseWatchAction, parseAtomicActionResult, toAtomicState } from './scoreboardWatchAction.js';
import { stripSensitiveControlFields } from './scoreboardControlToken.js';
import { assertScoreboardMutable, assertScoreboardScoringActive } from './scoreboardControlAuth.js';
import { assertScoreboardScoringSupported } from './scoreboardSportGuard.js';
import { registrarPunto, deshacerPunto, cambiarSaque, iniciarTiebreak, startCronometro, pauseCronometro, resetPartidoCompleto, buildHistorialPuntoSnapshot, applyHistorialPuntoSnapshot } from '../../utils/scoreboardLogic.js';
import { sendHttpError } from '../../lib/httpErrors.js';
import { scoreboardControlWriteRateLimit } from '../../lib/rateLimit.js';

export function installScoreboardWatchRoutes(app, { db, boardColumns, authenticate, authorize, present, publish, fetchHistory, assertHistory, afterMutation }) {
  async function board(id) {
    const { data, error } = await db.from('scoreboard_partidos').select(boardColumns).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('Partido no encontrado'), { status:404 });
    return stripSensitiveControlFields(data);
  }
  const wrap = (handler) => async(req,res) => {
    try { await handler(req,res); }
    catch(error) {
      if(error.status===409 && error.current_revision!=null) return res.status(409).json({accepted:false,duplicate:false,revision:Number(error.current_revision),scoreboard:null,server_time:new Date().toISOString(),error:error.message});
      return sendHttpError(res,error,{fallbackMessage:'No se pudo completar el control del reloj'});
    }
  };
  app.post('/api/scoreboard/partidos/:id/watch-sessions', wrap(async(req,res)=>{
    const auth=await authenticate(req);
    if(!auth.user) return res.status(auth.status).json({error:auth.error});
    const row=await board(req.params.id); await authorize(auth.user,row); assertScoreboardMutable(row);
    const {session,pairingCode}=await createWatchSession(db,row.id,req.body?.ttl_seconds);
    return res.status(201).json({session_id:session.id,pairing_code:pairingCode,pairing_expires_at:session.pairing_expires_at,expires_at:session.expires_at,revision:Number(row.revision)});
  }));
  app.post('/api/scoreboard/partidos/:id/watch-sessions/revoke',wrap(async(req,res)=>{
    const auth=await authenticate(req);
    if(!auth.user) return res.status(auth.status).json({error:auth.error});
    const row=await board(req.params.id); await authorize(auth.user,row);
    return res.json({ok:true,revoked_at:await revokeWatchSession(db,row.id,req.body?.session_id)});
  }));
  app.post('/api/scoreboard/watch/v1/pair',scoreboardControlWriteRateLimit,wrap(async(req,res)=>{
    const s=await claimWatchSession(db,req.body?.pairing_code,req.body?.device_id);
    return res.json({control_token:s.control_token,scoreboard_id:s.scoreboard_id,revision:Number(s.revision),expires_at:s.expires_at});
  }));
  const publicBoard = row => Object.fromEntries(boardColumns.split(',').map(key=>key.trim()).filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
  const response=async(result)=>({accepted:true,duplicate:result.deduplicated===true,revision:Number(result.revision),scoreboard:await present(publicBoard(result.scoreboard)),server_time:new Date().toISOString()});
  app.get('/api/scoreboard/watch/v1/control/:token',wrap(async(req,res)=>{
    const s=await resolveWatchSession(db,req.params.token,req.query.device_id);
    const row=await board(s.scoreboard_id);
    return res.json(await response({revision:row.revision,scoreboard:row}));
  }));
  app.post('/api/scoreboard/watch/v1/control/:token/commands',scoreboardControlWriteRateLimit,wrap(async(req,res)=>{
    const action=parseWatchAction(req.body);
    const session=await resolveWatchSession(db,req.params.token,action.device_id);
    const old=await db.from('scoreboard_control_actions').select('response').eq('session_id',session.id).eq('action_id',action.action_id).maybeSingle();
    if(old.error) throw old.error;
    if(old.data) return res.json(await response({...old.data.response,deduplicated:true}));
    const row=await board(session.scoreboard_id);
    if(Number(row.revision)!==action.expected_revision) throw Object.assign(new Error('El marcador cambió; sincronizá antes de reintentar'),{status:409,current_revision:row.revision});
    const before=row.estado, updatedAt=row.updated_at;
    assertScoreboardMutable(row);
    if(['punto','deshacer'].includes(action.command)) assertScoreboardScoringActive(row);
    if(action.command!=='cronometro'||action.accion==='reset') await assertScoreboardScoringSupported(db,row);
    let kind='update',history=null,historyId=null;
    if(action.command==='punto') { kind='point';history=buildHistorialPuntoSnapshot(row,action.equipo);registrarPunto(row,action.equipo); }
    else if(action.command==='deshacer') {
      if(!row.historial_puntos?.length) throw Object.assign(new Error('No hay puntos para deshacer'),{status:400});
      const entry=await fetchHistory(row.id);
      if(entry) {assertHistory(row,entry);applyHistorialPuntoSnapshot(row,entry);row.historial_puntos=[];kind='undo';historyId=entry.id;}
      else deshacerPunto(row);
    }
    else if(action.command==='saque') cambiarSaque(row);
    else if(action.command==='tiebreak') iniciarTiebreak(row);
    else if(action.accion==='start') startCronometro(row);
    else if(action.accion==='pause') pauseCronometro(row);
    else resetPartidoCompleto(row);
    const {data,error}=await db.rpc('scoreboard_apply_watch_action',{p_session_id:session.id,p_action_id:action.action_id,p_device_id:action.device_id,p_expected_revision:action.expected_revision,p_expected_updated_at:updatedAt,p_next:toAtomicState(row),p_kind:kind,p_history:history,p_history_id:historyId});
    if(error) throw error;
    const result=parseAtomicActionResult(data);
    if(!result.deduplicated) await afterMutation(result.scoreboard,before);
    await publish(result.scoreboard);
    return res.json(await response(result));
  }));
}
