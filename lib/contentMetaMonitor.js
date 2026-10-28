import {META_ACCOUNT,META_TIMEZONE,createContentMetaResults} from './contentMetaResults.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day=v=>new Intl.DateTimeFormat('en-CA',{timeZone:META_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
const dateText=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const shift=(v,n)=>new Date(Date.parse(v+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z_]{1,80}$/.test(e.code)?e.code:'META_MONITOR_FAILED';
export function metaMonitorConfig(env={}){
 const actor=String(env.META_ADS_AUTO_SYNC_ACTOR_ID||'');
 const enabled=env.META_ADS_AUTO_SYNC_ENABLED==='true';
 const configured=Boolean(env.META_ADS_READ_ACCESS_TOKEN&&env.META_ADS_READ_ACCOUNT_ID===META_ACCOUNT&&/^v\d+\.\d+$/.test(env.META_ADS_READ_GRAPH_VERSION||'')&&uuid.test(actor));
 return {enabled,configured,actor:uuid.test(actor)?actor:null,timezone:META_TIMEZONE,currency:'USD',intervalMs:3600000,afterHour:6,level:'campaign',policy:{dropPercent:40,minImpressions:1000,minLinkClicks:20,minSpend:20,costIncreasePercent:50}};
}
export function metaComparisonWindow(now=new Date()){
 const today=day(now),until=shift(today,-1),since=shift(today,-14);
 return {since,until,previous:{since,until:shift(today,-8)},current:{since:shift(today,-7),until}};
}
export function compareMetaCampaigns(previous,current,policy=metaMonitorConfig().policy){
 const prior=new Map(previous.map(r=>[r.entityId,r])),alerts=[];
 for(const row of current){const before=prior.get(row.entityId);if(!before)continue;
  const record=(kind,previousValue,currentValue,changePercent)=>alerts.push({entityId:row.entityId,kind,details:{campaignName:row.name,previousValue,currentValue,changePercent,unit:kind==='cost_per_link_click_increase'?'USD_per_link_click':'count',notice:'Cambio de rendimiento para revisar; no demuestra pérdida de ventas ni de consultas del CRM.'}});
  for(const [field,kind,min] of [['impressions','impressions_drop',policy.minImpressions],['linkClicks','link_clicks_drop',policy.minLinkClicks]]){
   if(typeof before[field]!=='number'||typeof row[field]!=='number'||before[field]<min||before[field]<=0)continue;
   // A partial link-click sum is not a complete count and cannot trigger a comparison.
   if(field==='linkClicks'&&(before.missingRows?.linkClicks||row.missingRows?.linkClicks))continue;
   const change=(row[field]/before[field]-1)*100;if(change<=-policy.dropPercent)record(kind,before[field],row[field],change);
  }
  if([before.spend,row.spend,before.linkClicks,row.linkClicks].every(v=>typeof v==='number'&&Number.isFinite(v))&&before.spend>=policy.minSpend&&row.spend>=policy.minSpend&&before.linkClicks>=policy.minLinkClicks&&row.linkClicks>=policy.minLinkClicks&&!before.missingRows?.linkClicks&&!row.missingRows?.linkClicks){
   const oldCost=before.spend/before.linkClicks,newCost=row.spend/row.linkClicks,change=(newCost/oldCost-1)*100;
   if(change>=policy.costIncreasePercent)record('cost_per_link_click_increase',oldCost,newCost,change);
  }
 }
 const present=new Set(current.map(r=>r.entityId));
 for(const before of previous)if(!present.has(before.entityId)&&typeof before.spend==='number'&&before.spend>=policy.minSpend)alerts.push({entityId:before.entityId,kind:'coverage_gap',details:{campaignName:before.name,notice:'Esta campaña no devolvió filas en la semana actual. Revisar si se pausó o dejó de tener entrega; no se inventan resultados ni ventas en cero.'}});
 return alerts;
}
export function createMetaMonitorRepository(pool){
 return {
  async acquire(){const client=await pool.connect();try{const r=await client.query('select pg_try_advisory_lock(1354015098,8083) locked');if(r.rows[0]?.locked!==true){client.release();return null;}return {client,async release(){let failure;try{await client.query('select pg_advisory_unlock(1354015098,8083)');}catch(e){failure=e;throw e;}finally{client.release(failure);}}};}catch(e){client.release();throw e;}},
  async authorized(client,actor){return (await client.query('select public.content_meta_access($1) allowed',[actor])).rows[0]?.allowed===true;},
  async begin(client,actor,window){await client.query('begin');try{const r=await client.query("insert into content_meta_sync_runs(account_id,until_day,since_day,status,actor_id) values($1,$2,$3,'running',$4) on conflict(account_id,until_day) do update set status='running',actor_id=excluded.actor_id,attempts=content_meta_sync_runs.attempts+1,started_at=now(),finished_at=null,error_code=null where content_meta_sync_runs.status<>'succeeded' returning account_id",[META_ACCOUNT,window.until,window.since,actor]);if(r.rowCount===1)await client.query("insert into content_meta_sync_events(account_id,until_day,event_type,details) values($1,$2,'started',$3)",[META_ACCOUNT,window.until,JSON.stringify({actor,since:window.since})]);await client.query('commit');return r.rowCount===1;}catch(e){await client.query('rollback');throw e;}},
  async coverage(client,window){return Number((await client.query("select count(*) days from content_meta_daily_sources s join content_meta_imports i on i.id=s.import_id where s.account_id=$1 and s.level='campaign' and s.day between $2 and $3 and i.status='committed' and i.source='meta_api' and (i.partial_day is null or s.day<>i.partial_day)",[META_ACCOUNT,window.since,window.until])).rows[0]?.days||0);},
  async succeed(client,window,comparison,alerts){await client.query('begin');try{for(const a of alerts)await client.query('insert into content_meta_monitor_alerts(account_id,until_day,entity_id,kind,details) values($1,$2,$3,$4,$5) on conflict do nothing',[META_ACCOUNT,window.until,a.entityId,a.kind,JSON.stringify(a.details)]);await client.query("update content_meta_sync_runs set status='succeeded',finished_at=now(),comparison=$3 where account_id=$1 and until_day=$2",[META_ACCOUNT,window.until,JSON.stringify(comparison)]);await client.query("insert into content_meta_sync_events(account_id,until_day,event_type,details) values($1,$2,'succeeded',$3)",[META_ACCOUNT,window.until,JSON.stringify({alertCount:alerts.length,comparisonStatus:comparison.status})]);await client.query('commit');}catch(e){await client.query('rollback');throw e;}},
  async fail(client,window,code){await client.query('begin');try{await client.query("update content_meta_sync_runs set status='failed',finished_at=now(),error_code=$3 where account_id=$1 and until_day=$2",[META_ACCOUNT,window.until,code]);await client.query("insert into content_meta_sync_events(account_id,until_day,event_type,details) values($1,$2,'failed',$3)",[META_ACCOUNT,window.until,JSON.stringify({code})]);await client.query('commit');}catch(e){await client.query('rollback');throw e;}},
 };
}
export function createMetaDailyMonitor({pool,env=process.env,now=()=>new Date(),logger=console,service=null,repository=null}={}){
 let running=false,timer=null;const config=metaMonitorConfig(env);
 if(!repository&&pool?.connect)repository=createMetaMonitorRepository(pool);
 async function runOnce(){
  if(!config.enabled)return {status:'disabled'};
  if(!config.configured)return {status:'not_configured'};
  if(!repository)return {status:'not_configured',code:'META_DATABASE_UNAVAILABLE'};
  if(running)return {status:'busy'};
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:META_TIMEZONE,hour:'numeric',hourCycle:'h23'}).format(now()));
  if(hour<config.afterHour)return {status:'waiting_for_complete_day'};
  running=true;let lock,window,started=false;
  try{
   lock=await repository.acquire();if(!lock)return {status:'busy'};
   if(!await repository.authorized(lock.client,config.actor))throw Object.assign(Error('Denied'),{code:'FORBIDDEN'});
   service??=createContentMetaResults({pool,env,now});
   window=metaComparisonWindow(now());started=await repository.begin(lock.client,config.actor,window);if(!started)return {status:'already_completed'};
   for(const level of ['campaign','adset','ad'])await service.sync(config.actor,{since:window.since,until:window.until,level});
   const coverage=await repository.coverage(lock.client,window);let alerts=[],comparison={...window,coverageDays:coverage,requiredDays:14,level:'campaign',policy:config.policy,status:'insufficient_coverage'};
   if(coverage===14){const previous=await service.insights(config.actor,{...window.previous,level:'campaign'}),current=await service.insights(config.actor,{...window.current,level:'campaign'});alerts=compareMetaCampaigns(previous.rows,current.rows,config.policy);comparison.status='compared';}
   else alerts=[{entityId:'account',kind:'coverage_gap',details:{coverageDays:coverage,requiredDays:14,notice:'No hay cobertura completa y comparable de 14 días; no se infiere rendimiento ni se sustituyen datos ausentes por cero.'}}];
   if(!await repository.authorized(lock.client,config.actor))throw Object.assign(Error('Denied'),{code:'FORBIDDEN'});
   await repository.succeed(lock.client,window,comparison,alerts);return {status:'succeeded',alertCount:alerts.length,comparison};
  }catch(e){const code=safeCode(e);if(started)try{await repository.fail(lock.client,window,code);}catch{logger?.error?.('[meta-monitor]',{code:'META_MONITOR_FAILURE_RECORD_FAILED'});}logger?.error?.('[meta-monitor]',{code});return {status:'failed',code};}
  finally{try{await lock?.release();}catch{logger?.error?.('[meta-monitor]',{code:'META_MONITOR_UNLOCK_FAILED'});}finally{running=false;}}
 }
 return {runOnce,start(){if(timer||!config.enabled)return;void runOnce();timer=setInterval(()=>void runOnce(),config.intervalMs);timer.unref?.();},stop(){if(timer)clearInterval(timer);timer=null;},status(){return {enabled:config.enabled,configured:config.configured,running,timezone:META_TIMEZONE,intervalMs:config.intervalMs,afterHour:config.afterHour,policy:config.policy};}};
}
export async function readMetaMonitorStatus({pool,actor,env=process.env}){
 const client=await pool.connect();try{if((await client.query('select public.content_meta_access($1) allowed',[actor])).rows[0]?.allowed!==true)throw Object.assign(Error('Forbidden'),{status:403,code:'FORBIDDEN'});const config=metaMonitorConfig(env);
 const actorAuthorized=config.actor?(await client.query('select public.content_meta_access($1) allowed',[config.actor])).rows[0]?.allowed===true:false;
 let latest=null,alerts=[];
 try {
  latest=(await client.query('select until_day,since_day,status,attempts,started_at,finished_at,error_code,comparison from content_meta_sync_runs where account_id=$1 order by until_day desc limit 1',[META_ACCOUNT])).rows[0]||null;
  alerts=(await client.query('select until_day,entity_id,kind,details,created_at from content_meta_monitor_alerts where account_id=$1 order by until_day desc,entity_id,kind limit 100',[META_ACCOUNT])).rows;
 } catch(e) {
  if(e.code!=='42P01')throw e;
  return {enabled:false,configured:config.configured,actorAuthorized,state:'setup_pending',timezone:META_TIMEZONE,policy:config.policy,latest:null,alerts:[],notice:'El control diario está preparado, pero todavía falta completar su habilitación. No se han comprobado resultados automáticos.'};
 }
 return {enabled:config.enabled,configured:config.configured,actorAuthorized,state:!config.enabled?'disabled':!config.configured?'not_configured':!actorAuthorized?'actor_not_authorized':latest?.status||'waiting_for_first_sync',timezone:META_TIMEZONE,intervalMs:config.intervalMs,afterHour:config.afterHour,policy:config.policy,latest:latest?{...latest,until_day:dateText(latest.until_day),since_day:dateText(latest.since_day)}:null,alerts:alerts.map(a=>({...a,until_day:dateText(a.until_day)})),notice:'Avisos internos diarios. No son ventas verificadas ni alertas en tiempo real; no se envían mensajes ni se modifican campañas.'};
 }finally{client.release();}
}
