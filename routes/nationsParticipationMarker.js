import {appendMarkerEvent, computeParticipation, createMarkerState} from '../lib/torneos/nationsParticipationMarker.js';
import {applyMatchGlobalCommand} from '../lib/torneos/nationsParticipationMatchGlobal.js';
const send=(res,code,obj)=>res.writeHead(code,{'content-type':'application/json'}).end(JSON.stringify(obj));
async function loadAgg(store, matchId, lineupsFor, actor, clock) {
  let agg=await store.getMatch(matchId);
  if (agg) return agg;
  const lineups=await lineupsFor(matchId, actor);
  if (!lineups?.t1||!lineups?.t2) throw Object.assign(new Error('MATCH_TEAMS_REQUIRED'),{code:'MATCH_TEAMS_REQUIRED'});
  agg={revision:0,states:{t1:createMarkerState({lineup:lineups.t1,startedAt:clock()}),t2:createMarkerState({lineup:lineups.t2,startedAt:clock()})},receipts:{}};
  const ok=await store.createMatch(matchId,agg);
  if (!ok) { agg=await store.getMatch(matchId); if(!agg) throw Object.assign(new Error('CREATE_RACE'),{code:'CREATE_RACE'}); }
  return agg;
}
export function createNationsParticipationMarkerHandler({authorize,clock,store,lineupFor,lineupsFor}) {
  return async function handler(req,res){
    const url=new URL(req.url,'http://local'); const m=url.pathname.match(/^\/api\/nations\/marker\/([^/]+)(\/events)?$/);
    if(!m)return send(res,404,{code:'NOT_FOUND'});
    const partidoId=m[1], teamId=url.searchParams.get('teamId')||'';
    try{
      const actor=await authorize(req,{partidoId,teamId}); if(!actor?.actorId)return send(res,401,{code:'UNAUTHORIZED'});
      if(actor.teamId!==teamId)return send(res,403,{code:'TEAM_FORBIDDEN'});
      const agg=await loadAgg(store,partidoId,lineupsFor,actor,clock); const state=agg.states[teamId];
      if(!state)return send(res,403,{code:'TEAM_FORBIDDEN'});
      const lineup=lineupFor?await lineupFor(partidoId,actor,teamId):(await lineupsFor(partidoId,actor))[teamId];
      if(req.method==='GET')return send(res,200,{teamId,lineup,startedAt:state.startedAt,state,participation:computeParticipation(state,lineup),matchRevision:agg.revision});
      if(req.method!=='POST'||!m[2])return send(res,405,{code:'METHOD_NOT_ALLOWED'});
      let body='';for await(const c of req)body+=c;const input=JSON.parse(body||'{}');
      if(['pause','resume','close'].includes(input.type))return send(res,400,{code:'GLOBAL_ONLY'});
      const canon=JSON.stringify(['team',partidoId,teamId,actor.actorId,input.type,input.eventId??null,input.outId??null,input.inId??null,input.targetEventId??null,input.patch??null,input.reason??null]);
      const existing=agg.receipts?.[input.idempotencyKey];
      if(existing){ if(existing._meta?.canon!==canon)return send(res,409,{code:'IDEMPOTENCY_CONFLICT'}); return send(res,200,{...existing,deduplicated:true}); }
      if(input.expectedRevision!==agg.revision)return send(res,409,{code:'REVISION_CONFLICT'});
      const r=appendMarkerEvent(state,input,{expectedRevision:state.revision,now:clock(),actorId:actor.actorId});
      const next={...agg,revision:agg.revision+1,states:{...agg.states,[teamId]:r.state},receipts:{...agg.receipts,[input.idempotencyKey]:{revision:agg.revision+1,event:r.event,deduplicated:r.deduplicated,_meta:{scope:'team',kind:'team-event',canon,actorId:actor.actorId}}}};
      if(!await store.saveMatch(partidoId,next,{expectedRevision:agg.revision}))return send(res,409,{code:'REVISION_CONFLICT'});
      return send(res,200,{revision:next.revision,event:r.event,deduplicated:r.deduplicated});
    }catch(e){const code=e.code||'INVALID';const status=e.status||(code==='UNAUTHORIZED'?401:code==='TEAM_FORBIDDEN'?403:code.endsWith('CONFLICT')?409:400);return send(res,status,{code});}
  };
}
export function createNationsMatchGlobalHandler({authorize,clock,store,lineupsFor}) {
  return async function handler(req,res){
    const url=new URL(req.url,'http://local'); const m=url.pathname.match(/^\/api\/nations\/marker\/([^/]+)\/global$/);
    if(!m)return send(res,404,{code:'NOT_FOUND'});
    const matchId=m[1];
    try{
      const actor=await authorize(req,{matchId}); if(!actor?.actorId)return send(res,401,{code:'UNAUTHORIZED'});
      if(actor.canControlMatch!==true)return send(res,403,{code:'MATCH_FORBIDDEN'});
      if(req.method!=='POST')return send(res,405,{code:'METHOD_NOT_ALLOWED'});
      let body='';for await(const c of req)body+=c;const input=JSON.parse(body||'{}');
      const agg=await loadAgg(store,matchId,lineupsFor,actor,clock);
      const gcanon=JSON.stringify(['global',matchId,actor.actorId,input.type,input.idempotencyKey]);
      const existing=agg.receipts?.[input.idempotencyKey]; if(existing){ if(existing._meta?.gcanon!==gcanon)return send(res,409,{code:'IDEMPOTENCY_CONFLICT'}); return send(res,200,{...existing,deduplicated:true}); }
      if(input.expectedRevision!==agg.revision)return send(res,409,{code:'REVISION_CONFLICT'});
      const {states,events}=applyMatchGlobalCommand({states:agg.states,command:input.type,now:clock(),actorId:actor.actorId,idempotencyKey:input.idempotencyKey});
      const receipt={revision:agg.revision+1,events,_meta:{scope:'global',kind:'match-global',gcanon,actorId:actor.actorId}}; const next={revision:agg.revision+1,states,receipts:{...agg.receipts,[input.idempotencyKey]:receipt}};
      if(!await store.saveMatch(matchId,next,{expectedRevision:agg.revision}))return send(res,409,{code:'REVISION_CONFLICT'});
      return send(res,200,receipt);
    }catch(e){const code=e.code||'INVALID';const status=e.status||(code==='UNAUTHORIZED'?401:code==='MATCH_FORBIDDEN'?403:code.endsWith('CONFLICT')?409:400);return send(res,status,{code});}
  };
}
