import {appendMarkerEvent, computeParticipation, createMarkerState} from './nationsParticipationMarker.js';
import {applyMatchGlobalCommand} from './nationsParticipationMatchGlobal.js';
import {loadNationsMarkerMatchContext} from './nationsMarkerMatchContext.js';
import {clockSnapshot, clockMismatch} from './nationsMarkerClockContinuity.js';
import {NationsMarkerPostgresStore} from './nationsMarkerPostgresStore.js';
const fail=(code,status=409)=>{throw Object.assign(new Error(code),{code,status})};
const stable=(v)=>Array.isArray(v)?v.map(stable):(v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v);
const canon=(scope,kind,actor,payload)=>JSON.stringify(stable([scope,kind,actor,payload]));
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
export async function executeNationsMarkerCommand({pool,authorize,req,scoreboardId,command,idempotencyKey,expectedRevision,teamId=null,eventId=null,body={}}) {
  if(!idempotencyKey) fail('IDEMPOTENCY_KEY_REQUIRED',400);
  const actor=await authorize(req,{matchId:scoreboardId,teamId});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const sb=await client.query('SELECT id,cronometro_inicio,cronometro_pausado,cronometro_segundos,estado,updated_at FROM scoreboard_partidos WHERE id=$1 FOR UPDATE',[scoreboardId]);
    if(!sb.rows[0]) fail('SCOREBOARD_NOT_FOUND',404);
    const ctx=await loadNationsMarkerMatchContext(client,scoreboardId);
    const aggR=await client.query('SELECT revision,states,receipts FROM nations_marker_private.nations_marker_match WHERE match_id=$1 FOR UPDATE',[scoreboardId]);
    if(!aggR.rows[0]) fail('TRACKING_NOT_STARTED');
    const agg={revision:Number(aggR.rows[0].revision),states:aggR.rows[0].states,receipts:aggR.rows[0].receipts};
    const scope=command==='pause'||command==='resume'||command==='close'?'global':'team';
    const clean={}; for(const k of ['outId','inId','targetEventId','patch','reason']) if(Object.prototype.hasOwnProperty.call(body,k)) clean[k]=body[k];
    const c=canon(scope,command,actor.actorId,{scoreboardId,teamId,eventId,body:clean});
    const existing=agg.receipts[idempotencyKey];
    if(existing){ if(existing._meta?.canon!==c) fail('IDEMPOTENCY_CONFLICT'); await client.query('COMMIT'); return {deduplicated:true,revision:agg.revision,receipt:existing}; }
    if(expectedRevision!==agg.revision) fail('REVISION_CONFLICT');
    if(command==='close' && !['terminado','finalizado'].includes(String(sb.rows[0].estado||'').toLowerCase())) fail('MATCH_NOT_TERMINATED',409);
    const ts=(await client.query('SELECT clock_timestamp() AS ts')).rows[0].ts;
    const now=new Date(ts).getTime();
    let terminalAt=null; if(command==='close'){ const t=await client.query("SELECT to_regclass('nations_marker_private.nations_marker_terminal') AS t"); if(t.rows[0]?.t){ const r=await client.query('SELECT terminal_at FROM nations_marker_private.nations_marker_terminal WHERE match_id=$1',[scoreboardId]); terminalAt=r.rows[0]?.terminal_at||null; } if(!terminalAt) fail('TERMINAL_TIMESTAMP_MISSING',409); } const closeAtMs=command==='close'?new Date(terminalAt).getTime():null;
    if(command==='close'&&(!Number.isFinite(closeAtMs)||closeAtMs<=0||closeAtMs>now)) fail('CLOCK_OUT_OF_SYNC');
    const eventNow=command==='close'?closeAtMs:now;
    if(!Number.isFinite(now)||now<=0) fail('CLOCK_INVALID',500);
    if(command==='correction'){ const st=agg.states[teamId]; const target=st?.events?.find(e=>e.eventId===body.targetEventId); if(!target||target.type!=='substitution') fail('CORRECTION_TARGET_INVALID',400); const allowed=new Set(['outId','inId','serverAt']); if(Object.keys(body.patch||{}).some(k=>!allowed.has(k))) fail('CORRECTION_PATCH_INVALID',400); }
    const revRow=await client.query('SELECT revision FROM nations_marker_private.nations_marker_clock_revision WHERE scoreboard_id=$1',[scoreboardId]); const expectedClock=agg.receipts?.__clock; const currentClock=clockSnapshot(sb.rows[0],revRow.rows[0]?.revision||0);
    const trackingClosed=agg.states && Object.values(agg.states).every(s=>['closed','corrected'].includes(s.status));
    const mismatch=expectedClock?clockMismatch(expectedClock,currentClock,trackingClosed):'CLOCK_SNAPSHOT_MISSING';
    const terminalTransition=command==='close' && expectedClock && Number(currentClock.clockRevision)===Number(expectedClock.clockRevision)+1 && ['terminado','finalizado'].includes(String(currentClock.estado||'').toLowerCase()) && ['en_curso','pendiente','pausado'].includes(String(expectedClock.estado||'').toLowerCase()) && expectedClock.inicio===currentClock.inicio && expectedClock.pausado===currentClock.pausado && Number(expectedClock.segundos)===Number(currentClock.segundos);
    if(mismatch && !terminalTransition) fail('CLOCK_OUT_OF_SYNC');
    const baseline=agg.receipts?.start;
    if(!baseline) fail('TRACKING_INCOMPLETE');
    for(const [id,t] of Object.entries(ctx.teams)){ if(Number(baseline.lineup?.[id])!==Number(t.lineup.revision)) fail('LINEUP_REVISION_CHANGED'); }
    let next; let clockSql=null;
    if(scope==='global'){
      if(command==='pause'||command==='close'){
        const started= sb.rows[0].cronometro_inicio ? new Date(sb.rows[0].cronometro_inicio).getTime() : null; if(started!=null&&(!Number.isFinite(started)||eventNow<started)) fail('CLOCK_OUT_OF_SYNC'); const elapsed= started!=null ? Math.floor((eventNow-started)/1000) : 0; if(!Number.isFinite(elapsed)||elapsed<0) fail('CLOCK_INVALID',500);
        const baseSecs=Number(sb.rows[0].cronometro_segundos)||0; if(!Number.isFinite(baseSecs)||baseSecs<0) fail('CLOCK_INVALID',500); const secs=baseSecs+(started!=null?elapsed:0);
        clockSql={inicio:null,pausado:true,segundos:secs};
      } else if(command==='resume'){
        clockSql={inicio:ts,pausado:false,segundos:Number(sb.rows[0].cronometro_segundos)||0};
      }
      const r=applyMatchGlobalCommand({states:agg.states,command,now:eventNow,actorId:actor.actorId,idempotencyKey}); next={revision:agg.revision+1,states:r.states,receipts:{...agg.receipts,__clock:clockSnapshot({...sb.rows[0],...(clockSql?{cronometro_inicio:clockSql.inicio,cronometro_pausado:clockSql.pausado,cronometro_segundos:clockSql.segundos}:{})},(await client.query('SELECT revision FROM nations_marker_private.nations_marker_clock_revision WHERE scoreboard_id=$1',[scoreboardId])).rows[0]?.revision||0),[idempotencyKey]:{revision:agg.revision+1,events:r.events,_meta:{scope,kind:command,actorId:actor.actorId,canon:c}}}};
    } else {
      if(!teamId||!['substitution','correction'].includes(command)) fail('COMMAND_INVALID',400);
      if(!ctx.teams[teamId]) fail('TEAM_NOT_IN_MATCH',403);
      const state=agg.states[teamId]; if(!state) fail('TEAM_STATE_MISSING');
      if(command==='correction'){ const target=state.events.find(e=>e.eventId===body.targetEventId); if(!target||target.type!=='substitution') fail('CORRECTION_TARGET_INVALID'); const allowed=new Set(['outId','inId','serverAt']); if(Object.keys(body.patch||{}).some(k=>!allowed.has(k))) fail('CORRECTION_PATCH_INVALID'); }
      const r=appendMarkerEvent(state,{...clean,type:command,eventId,idempotencyKey},{expectedRevision:state.revision,now,actorId:actor.actorId});
      next={revision:agg.revision+1,states:{...agg.states,[teamId]:r.state},receipts:{...agg.receipts,__clock:currentClock,[idempotencyKey]:{revision:agg.revision+1,event:r.event,_meta:{scope,kind:command,actorId:actor.actorId,canon:c}}}};
    }
    const validator=new NationsMarkerPostgresStore({pool}); validator.validateMatch(scoreboardId,next);
    for(const [t,st] of Object.entries(agg.states)){const pe=st.events||[],ne=next.states[t].events||[];if(ne.length<pe.length||!pe.every((e,i)=>same(e,ne[i]))) fail('EVENT_HISTORY_MUTATED');}
    for(const [k,v] of Object.entries(agg.receipts)) if(k!=='__clock' && !same(v,next.receipts[k])) fail('RECEIPTS_MUTATED');
    await client.query('UPDATE nations_marker_private.nations_marker_match SET revision=$2,states=$3::jsonb,receipts=$4::jsonb,updated_at=now() WHERE match_id=$1 AND revision=$5',[scoreboardId,next.revision,JSON.stringify(next.states),JSON.stringify(next.receipts),agg.revision]);
    if(clockSql) await client.query('UPDATE scoreboard_partidos SET cronometro_inicio=$2,cronometro_pausado=$3,cronometro_segundos=$4,updated_at=now() WHERE id=$1',[scoreboardId,clockSql.inicio,clockSql.pausado,clockSql.segundos]);
    if(clockSql){ const fin=await client.query('SELECT s.cronometro_inicio,s.cronometro_pausado,s.cronometro_segundos,s.estado,COALESCE(cr.revision,0) AS clock_revision FROM scoreboard_partidos s LEFT JOIN nations_marker_private.nations_marker_clock_revision cr ON cr.scoreboard_id=s.id::text WHERE s.id=$1',[scoreboardId]); const finalClock=clockSnapshot(fin.rows[0],fin.rows[0]?.clock_revision||0); await client.query("UPDATE nations_marker_private.nations_marker_match SET receipts=jsonb_set(receipts,'{__clock}',$2::jsonb,true) WHERE match_id=$1 AND revision=$3",[scoreboardId,JSON.stringify(finalClock),next.revision]); next.receipts.__clock=finalClock; }
    await client.query('INSERT INTO nations_marker_private.nations_marker_audit(match_id,revision,kind,actor,payload) VALUES($1,$2,$3,$4,$5::jsonb)',[scoreboardId,next.revision,command,actor.actorId,JSON.stringify({idempotencyKey,teamId,eventId,clock:clockSql})]);
    await client.query('COMMIT');
    return {deduplicated:false,revision:next.revision,clock:clockSql};
  }catch(e){try{await client.query('ROLLBACK')}catch{} throw e;} finally{client.release();}
}
