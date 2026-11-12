import {withGamesLedgerRead,withGamesParticipation} from '../lib/torneos/nationsGamesReadCandidate.js';
import {restartGamesTracking} from '../lib/torneos/nationsGamesRestartCandidate.js';
import {loadNationsMarkerMatchContext} from '../lib/torneos/nationsMarkerMatchContext.js';
import {NationsMarkerPostgresStore} from '../lib/torneos/nationsMarkerPostgresStore.js';
import {startNationsMarkerTracking} from '../lib/torneos/nationsMarkerStartTracking.js';
import {clockSnapshot, clockMismatch} from '../lib/torneos/nationsMarkerClockContinuity.js';
import {computeParticipation} from '../lib/torneos/nationsParticipationMarker.js';
import {readSubstitutionWindow} from '../lib/torneos/nationsChangeEnds.js';
import {executeNationsMarkerCommand} from '../lib/torneos/nationsMarkerCommands.js';
const sendJson=(res,code,obj)=>res.writeHead(code,{'content-type':'application/json'}).end(JSON.stringify(obj));
const hasAuthority=(b)=>['actor','actorId','clock','serverAt','serverNow','startedAt'].some(k=>Object.prototype.hasOwnProperty.call(b||{},k));
/** Factory aislado; OFF por defecto: solo se monta si el instalador lo decide. */
export function createNationsMarkerDurableRouter({pool,authorize,present=value=>value}) {
  const send=(res,code,obj)=>sendJson(res,code,present(obj));
  const store=new (withGamesLedgerRead(NationsMarkerPostgresStore))({pool});
  return async function handler(req,res){
    try{
      const url=new URL(req.url,'http://local');
      const cm=url.pathname.match(/^\/api\/nations\/marker\/([^/]+)\/context$/);
      if(cm && req.method==='GET'){
        await authorize(req,{matchId:cm[1]});
        const ctx=await loadNationsMarkerMatchContext(pool,cm[1]);
        const agg=await store.getMatch(cm[1]);
        const sb=await pool.query('SELECT cronometro_inicio,cronometro_pausado,cronometro_segundos,cancha,estado FROM scoreboard_partidos WHERE id=$1',[cm[1]]);
        const row=sb.rows[0]||{};
        const canStart=!agg && Boolean(String(row.cancha||'').trim()) && row.cronometro_inicio==null && row.cronometro_pausado!==true && (Number(row.cronometro_segundos)||0)===0;
        const teams=Object.fromEntries(Object.entries(ctx.teams).map(([id,t])=>[id,{teamId:id,lineup:t.lineup,players:t.players||[]}]));
        const substitution_window=agg?await readSubstitutionWindow(pool,cm[1]):{allowed:false,reason:'TRACKING_NOT_STARTED',completed_games:0,set_number:1};
        return send(res,200,{substitution_window,scoreboardId:cm[1],membership:ctx.membership,teamIds:Object.keys(teams),teams,hasBaseline:!!agg,canStart,canRestart:agg?.trackingStatus==='reset_pending',gamesEpoch:agg?.gamesEpoch,trackingStatus:agg?.trackingStatus});
      }
      const m=url.pathname.match(/^\/api\/nations\/marker\/([^/]+)(?:\/(start|restart|team\/([^/]+)\/commands|global\/commands))?$/);
      if(!m)return send(res,404,{code:'NOT_FOUND'});
      const scoreboardId=m[1]; let body={};
      if(req.method==='POST'){ if(req.body && typeof req.body==='object'){ body=req.body; } else { let raw='';for await(const c of req)raw+=c;try{body=JSON.parse(raw||'{}')}catch{return send(res,400,{code:'BODY_INVALID'})} } if(hasAuthority(body))return send(res,400,{code:'BODY_AUTHORITY_FORBIDDEN'});}
      if(req.method==='GET'){
        const teamId=(url.searchParams.get('teamId')||null);
        await authorize(req,{matchId:scoreboardId,teamId});
        const agg=await store.getMatch(scoreboardId); if(!agg)return send(res,409,{code:'TRACKING_NOT_STARTED'});
        const ctx=await loadNationsMarkerMatchContext(pool,scoreboardId);
        if(!teamId)return send(res,400,{code:'TEAM_ID_REQUIRED'});
        if(!ctx.teams[teamId])return send(res,403,{code:'TEAM_NOT_IN_MATCH'});
        if(agg.trackingStatus==='reset_pending')return send(res,200,withGamesParticipation({teamId,lineup:ctx.teams[teamId].lineup,matchRevision:agg.revision,teamIds:Object.keys(ctx.teams)},agg,teamId));
        const sb=await pool.query('SELECT cronometro_inicio,cronometro_pausado,cronometro_segundos,estado FROM scoreboard_partidos WHERE id=$1',[scoreboardId]);
        const trackingClosed=Object.values(agg.states).every(s=>['closed','corrected'].includes(s.status));
        const cr=await pool.query('SELECT revision FROM nations_marker_private.nations_marker_clock_revision WHERE scoreboard_id=$1',[scoreboardId]);
        const mismatch=clockMismatch(agg.receipts?.__clock, clockSnapshot(sb.rows[0],cr.rows[0]?.revision||0), trackingClosed);
        const participation=mismatch?{status:'unconfirmed',reason:'CLOCK_OUT_OF_SYNC',players:null,percentage:null,denominator:null,percentageStatus:'pending_definition'}:{...computeParticipation(agg.states[teamId],ctx.teams[teamId].lineup)};
        const substitution_window=await readSubstitutionWindow(pool,scoreboardId);
        const body={substitution_window,teamId,lineup:ctx.teams[teamId].lineup,state:agg.states[teamId],participation,matchRevision:agg.revision,teamIds:Object.keys(ctx.teams)};
        if(mismatch) body.code='CLOCK_OUT_OF_SYNC';
        return send(res,200,withGamesParticipation(body,agg,teamId));
      }
      if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
      if(!body.idempotencyKey)return send(res,400,{code:'IDEMPOTENCY_KEY_REQUIRED'});
      if(m[2]==='restart'){const r=await restartGamesTracking({pool,authorize,loadContext:(c,id)=>loadNationsMarkerMatchContext(c,id,{lock:true}),clockSnapshot,req,scoreboardId,requestId:body.requestId,epoch:body.epoch});return send(res,200,r);}
      if(m[2]==='start'){
        const r=await startNationsMarkerTracking({pool,authorize,req,scoreboardId,idempotencyKey:body.idempotencyKey,payload:body.payload||{}});
        return send(res,200,{startedAt:r.startedAt,revision:r.revision,receipt:r.receipt,deduplicated:r.deduplicated});
      }
      if(m[2]?.startsWith('team/')){
        const r=await executeNationsMarkerCommand({pool,authorize,req,scoreboardId,command:body.type,teamId:m[3],eventId:body.eventId,idempotencyKey:body.idempotencyKey,expectedRevision:body.expectedRevision,body});
        return send(res,200,r);
      }
      if(m[2]==='global/commands'){
        const r=await executeNationsMarkerCommand({pool,authorize,req,scoreboardId,command:body.type,idempotencyKey:body.idempotencyKey,expectedRevision:body.expectedRevision,body});
        return send(res,200,r);
      }
      return send(res,400,{code:'ROUTE_INVALID'});
    }catch(e){const code=e.code||'INVALID';let status=e.status;if(!status){const validation=new Set(['TEAM_ID_REQUIRED','BODY_INVALID','BODY_AUTHORITY_FORBIDDEN','IDEMPOTENCY_KEY_REQUIRED','OUT_NOT_ACTIVE','IN_ALREADY_ACTIVE','IN_NOT_IN_LINEUP','EVENT_INVALID','EVENT_ID_REQUIRED','EVENT_ID_DUPLICATE','PAUSE_INVALID','RESUME_INVALID','CORRECTION_INVALID','CORRECTION_TARGET_INVALID','CORRECTION_REASON_REQUIRED','CORRECTION_PATCH_REQUIRED','CORRECTION_PATCH_INVALID','SUBSTITUTION_NOT_OPEN','COMMAND_INVALID','SUBSTITUTION_BATCH_INVALID','ACTIVE_NOT_IN_LINEUP','STATE_INVALID','REVISION_STEP_INVALID']);
 if(code==='AUTH_REQUIRED')status=401;else if(['FORBIDDEN','FORBIDDEN_SEDE','TEAM_NOT_IN_MATCH'].includes(code))status=403;else if(validation.has(code))status=400;else if(code.endsWith('CONFLICT')||['CHANGE_ENDS_REQUIRED','TRACKING_NOT_STARTED','TRACKING_INCOMPLETE','START_ALREADY_EXISTS','CLOCK_OUT_OF_SYNC','LINEUP_REVISION_CHANGED','CLOCK_INVALID'].includes(code))status=409;else status=503;}return send(res,status,{code});}
  };
}
