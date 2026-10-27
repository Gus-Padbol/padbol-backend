import {createHash,randomUUID} from 'node:crypto';
export const META_ACCOUNT='1354015098808083';
export const META_TIMEZONE='America/Los_Angeles';
const levels=new Set(['campaign','adset','ad']);
const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const pacificDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:META_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const id=value=>typeof value==='string'&&/^\d{1,30}$/.test(value);
const decimal=value=>{if(value==='')return null;if(!/^\d+(?:[.,]\d{1,8})?$/.test(value))throw fail('INVALID_NUMBER');return value.replace(',','.');};
const integer=value=>{if(value==='')return null;if(!/^\d{1,16}$/.test(value)||BigInt(value)>9007199254740991n)throw fail('INVALID_INTEGER');return value;};
const columns={campaign:{id:'Identificador de la campaña',name:'Nombre de la campaña'},adset:{id:'Identificador del conjunto de anuncios',name:'Nombre del conjunto de anuncios'},ad:{id:'Identificador del anuncio',name:'Nombre del anuncio'}};
function* metaCsvRecords(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>30*1024*1024||text.includes('\u0000'))throw fail('INVALID_FILE');
 text=text.replace(/^\uFEFF/,'');const first=text.split(/\r?\n/,1)[0],separator=first.includes(';')&&!first.includes(',')?';':',';
 let row=[],parts=[],start=0,quoted=false,closed=false,fieldLength=0,count=0;
 const put=end=>{if(!closed)parts.push(text.slice(start,end));const cell=parts.length===1?parts[0]:parts.join('');if(cell.length>10000||row.length>=80)throw fail('INVALID_CELL');row.push(cell);parts=[];closed=false;fieldLength=0;};
 for(let i=0;i<text.length;i++){const ch=text[i];if(i-start+fieldLength>10000)throw fail('INVALID_CELL');
  if(quoted){if(ch==='"'){parts.push(text.slice(start,i));fieldLength+=i-start;if(text[i+1]==='"'){parts.push('"');fieldLength++;i++;start=i+1;}else{quoted=false;closed=true;start=i+1;}}}
  else if(ch==='"'){if(i!==start||parts.length||closed)throw fail('INVALID_CSV_QUOTE');quoted=true;start=i+1;}
  else if(ch===separator||ch==='\n'||ch==='\r'){put(i);if(ch===separator){start=i+1;continue;}if(ch==='\r'&&text[i+1]==='\n')i++;start=i+1;if(row.some(x=>x!=='')){if(++count>100001)throw fail('TOO_MANY_ROWS');yield row;}row=[];}
  else if(closed)throw fail('INVALID_CSV_QUOTE');
 }
 if(quoted)throw fail('INVALID_CSV_QUOTE');if(start<text.length||row.length||closed){put(text.length);if(row.some(x=>x!=='')){if(++count>100001)throw fail('TOO_MANY_ROWS');yield row;}}
}
export function parseMetaCsv(text){const iterator=metaCsvRecords(text),headers=iterator.next().value;if(!headers)throw fail('EMPTY_CSV');if(new Set(headers).size!==headers.length)throw fail('DUPLICATE_COLUMN');const records=[];for(const row of iterator){if(row.length!==headers.length)throw fail('INVALID_ROW_WIDTH');records.push(Object.fromEntries(headers.map((h,i)=>[h,row[i]])));}if(!records.length)throw fail('EMPTY_CSV');return {headers,records};}
export function normalizeMetaCsv(buffer,metadata={},now=new Date()){
 const csv=buffer.toString('utf8');if(csv.includes('\uFFFD'))throw fail('INVALID_ENCODING');const records=metaCsvRecords(csv),headers=records.next().value;if(!headers)throw fail('EMPTY_CSV');if(new Set(headers).size!==headers.length)throw fail('DUPLICATE_COLUMN');
 const level=headers.includes(columns.ad.id)?'ad':headers.includes(columns.adset.id)?'adset':headers.includes(columns.campaign.id)?'campaign':null;if(!level)throw fail('UNKNOWN_LEVEL');
 for(const key of ['Inicio del informe','Fin del informe','Identificador de la cuenta',columns[level].id,columns[level].name,'Monto gastado (USD)','Impresiones'])if(!headers.includes(key))throw fail('MISSING_COLUMN');
 if(metadata.timezone&&metadata.timezone!==META_TIMEZONE||metadata.currency&&metadata.currency!=='USD')throw fail('SOURCE_UNIT_MISMATCH');
 const exportedAt=metadata.exportedAt||now.toISOString(),dateOnly=date(exportedAt);if(typeof exportedAt!=='string'||(!dateOnly&&(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(exportedAt)||!date(exportedAt.slice(0,10))))||!Number.isFinite(Date.parse(exportedAt))||(!dateOnly&&Date.parse(exportedAt)>now.getTime()+300000)||dateOnly&&exportedAt>pacificDay(now))throw fail('INVALID_EXPORT_DATE');
 const exportDay=dateOnly?exportedAt:pacificDay(exportedAt),partialDay=metadata.partialDay||exportDay;if(!date(partialDay)||partialDay!==exportDay)throw fail('INVALID_PARTIAL_DAY');
 const seen=new Set(),strings=new Map(),intern=value=>{if(value===null||value===undefined)return value;if(!strings.has(value))strings.set(value,value);return strings.get(value);},today=pacificDay(now);let from='9999-12-31',to='0000-01-01';const rows=[];
 for(const values of records){if(values.length!==headers.length)throw fail('INVALID_ROW_WIDTH');const r=Object.fromEntries(headers.map((h,i)=>[h,values[i]]));const day=intern(r['Inicio del informe']);if(!date(day)||r['Fin del informe']!==day||(day>today||day>exportDay))throw fail('INVALID_DAILY_DATE');if(r['Identificador de la cuenta']!==META_ACCOUNT)throw fail('WRONG_ACCOUNT');
  const entity=intern(r[columns[level].id]),campaign=intern(r['Identificador de la campaña']);if(!id(entity)||!id(campaign)||level==='ad'&&!id(r[columns.adset.id]))throw fail('INVALID_ENTITY_ID');
  const key=day+':'+entity;if(seen.has(key))throw fail('DUPLICATE_DAILY_ENTITY');seen.add(key);if(day<from)from=day;if(day>to)to=day;
  rows.push({day,entity_id:entity,entity_name:intern(r[columns[level].name]),campaign_id:campaign,campaign_name:intern(r['Nombre de la campaña']||''),adset_id:level==='campaign'?null:intern(r[columns.adset.id]),adset_name:intern(r['Nombre del conjunto de anuncios']||null),ad_id:level==='ad'?entity:null,
   spend:decimal(r['Monto gastado (USD)']),impressions:integer(r.Impresiones),clicks:integer(r['Clics (todos)']||''),link_clicks:integer(r['Clics en el enlace']||''),reach_daily:integer(r.Alcance||''),results:decimal(r.Resultados||''),result_indicator:intern(r['Indicador de resultado']||null),attribution:intern(r['Configuración de atribución']||null),actions:{}});
 }
 if(!rows.length)throw fail('EMPTY_CSV');
 return {hash:createHash('sha256').update(buffer).digest('hex'),csv,level,rows,from,to,exportedAt:dateOnly?exportedAt:new Date(exportedAt).toISOString(),exportedAtPrecision:dateOnly?'date':'timestamp',partialDay,timezone:META_TIMEZONE,currency:'USD',coverage:String(metadata.coverage||'').slice(0,2000),warnings:['Los niveles de campaña, conjunto y anuncio no se suman entre sí.','El alcance diario no equivale al alcance único del período.',...(partialDay>=from&&partialDay<=to?['El día '+partialDay+' está incompleto y se excluye por defecto.']:[]),...(level==='adset'?['Confirma si la exportación de conjuntos incluye los eliminados con entrega.']:[])]};
}
const scaled=value=>{const [a,b='']=String(value).split('.');return BigInt(a)*100000000n+BigInt(b.padEnd(8,'0'));};
const unscale=value=>Number(value)/100000000;
export function aggregateMetaRows(rows){
 const groups=new Map();const make=()=>({sum:{},missing:{},indicators:new Map()});const total=make();
 const add=(g,r)=>{for(const k of ['spend','impressions','clicks','link_clicks'])if(r[k]!==null&&r[k]!==undefined)g.sum[k]=(g.sum[k]??0n)+scaled(r[k]);else g.missing[k]=(g.missing[k]||0)+1;if(r.result_indicator&&r.result_indicator!=='reach'&&r.results!==null)g.indicators.set(r.result_indicator,(g.indicators.get(r.result_indicator)??0n)+scaled(r.results));for(const [k,v]of Object.entries(r.actions||{}))if(k!=='reach'&&k!=='actions:reach'&&v!==null)g.indicators.set(k,(g.indicators.get(k)??0n)+scaled(v));};
 for(const r of rows){let g=groups.get(r.entity_id);if(!g){g={...make(),entityId:r.entity_id,name:r.entity_name,campaignId:r.campaign_id,campaignName:r.campaign_name,adsetId:r.adset_id,adsetName:r.adset_name,adId:r.ad_id};groups.set(r.entity_id,g);}add(g,r);add(total,r);}
 const out=g=>{const n=k=>g.sum[k]===undefined||(k!=='link_clicks'&&g.missing[k])?null:unscale(g.sum[k]);return {spend:n('spend'),impressions:n('impressions'),clicks:n('clicks'),linkClicks:n('link_clicks'),ctr:g.sum.impressions&&g.sum.clicks!==undefined&&!g.missing.clicks&&!g.missing.impressions?Number(g.sum.clicks)*100/Number(g.sum.impressions):null,missingRows:{spend:g.missing.spend||0,impressions:g.missing.impressions||0,clicks:g.missing.clicks||0,linkClicks:g.missing.link_clicks||0},linkCtr:g.sum.impressions&&g.sum.link_clicks!==undefined&&!g.missing.link_clicks&&!g.missing.impressions?Number(g.sum.link_clicks)*100/Number(g.sum.impressions):null,reach:null,results:[...g.indicators].map(([indicator,value])=>({indicator,value:unscale(value)}))};};
 return {rows:[...groups.values()].map(g=>({entityId:g.entityId,name:g.name,campaignId:g.campaignId,campaignName:g.campaignName,adsetId:g.adsetId,adsetName:g.adsetName,adId:g.adId,...out(g)})).sort((a,b)=>(b.spend??0)-(a.spend??0)),summary:out(total)};
}
const dayString=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const importDto=r=>({id:r.id,filename:r.filename,level:r.level,status:r.status,rowCount:r.row_count,from:dayString(r.from_day),to:dayString(r.to_day),importedAt:r.committed_at||r.created_at,exportedAt:r.exported_at,exportedAtPrecision:r.exported_precision,source:r.source,partialDay:r.partial_day?dayString(r.partial_day):null,timezone:r.timezone,currency:r.currency,active:r.active===true,coverage:r.coverage});
export function createContentMetaResults({pool,env=process.env,fetchImpl=globalThis.fetch,now=()=>new Date()}){
 if(!pool?.connect)throw Error('META_DATABASE_UNAVAILABLE');
 const tx=async(actor,fn)=>{const c=await pool.connect();try{await c.query('begin');const access=await c.query('select public.content_meta_access($1) allowed',[actor]);if(access.rows[0]?.allowed!==true)throw fail('FORBIDDEN',403);const result=await fn(c);await c.query('commit');return result;}catch(e){await c.query('rollback');throw e;}finally{c.release();}};
 const imports=async c=>(await c.query('select i.id,i.filename,i.level,i.status,i.row_count,i.from_day,i.to_day,i.created_at,i.committed_at,i.exported_at,i.exported_precision,i.source,i.partial_day,i.timezone,i.currency,i.coverage,exists(select 1 from content_meta_daily_sources s where s.import_id=i.id) active from content_meta_imports i order by i.created_at desc limit 100')).rows;
 async function stage(actor,d,filename,source){
  return tx(actor,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[META_ACCOUNT+':'+d.level+':'+d.hash]);
   let old=(await c.query('select * from content_meta_imports where account_id=$1 and level=$2 and sha256=$3',[META_ACCOUNT,d.level,d.hash])).rows[0];
   if(old){if(old.timezone!==d.timezone||old.currency!==d.currency||dayString(old.partial_day)!==d.partialDay)throw fail('SOURCE_METADATA_CONFLICT',409);if(old.status==='preview'&&new Date(old.expires_at).getTime()<now().getTime())await c.query("update content_meta_imports set expires_at=now()+interval '24 hours' where id=$1",[old.id]);return {previewId:old.id,hash:d.hash,level:d.level,rowCount:old.row_count,from:d.from,to:d.to,warnings:d.warnings,sample:d.rows.slice(0,5),existingImportId:old.status==='committed'?old.id:undefined};}
   const key=randomUUID();await c.query('insert into content_meta_imports(id,account_id,level,sha256,filename,raw_csv,source,timezone,currency,exported_at,exported_precision,partial_day,coverage,from_day,to_day,row_count,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[key,META_ACCOUNT,d.level,d.hash,String(filename).slice(0,200),d.csv,source,d.timezone,d.currency,d.exportedAt,d.exportedAtPrecision,d.partialDay,d.coverage,d.from,d.to,d.rows.length,actor]);
   for(let offset=0;offset<d.rows.length;offset+=1000)await c.query(`insert into content_meta_rows(import_id,day,entity_id,campaign_id,campaign_name,adset_id,adset_name,ad_id,entity_name,spend,impressions,clicks,link_clicks,reach_daily,results,result_indicator,attribution,actions) select $1,x.* from jsonb_to_recordset($2::jsonb) as x(day date,entity_id text,campaign_id text,campaign_name text,adset_id text,adset_name text,ad_id text,entity_name text,spend numeric,impressions bigint,clicks bigint,link_clicks bigint,reach_daily bigint,results numeric,result_indicator text,attribution text,actions jsonb)`,[key,JSON.stringify(d.rows.slice(offset,offset+1000))]);
   await c.query("insert into content_meta_audit(import_id,actor_id,action,details)values($1,$2,'preview',$3)",[key,actor,JSON.stringify({sha256:d.hash,rowCount:d.rows.length,source,level:d.level})]);
   return {previewId:key,hash:d.hash,level:d.level,rowCount:d.rows.length,from:d.from,to:d.to,warnings:d.warnings,sample:d.rows.slice(0,5)};
  });
 }
 async function preview(actor,buffer,filename,metadata={},source='csv'){return stage(actor,normalizeMetaCsv(buffer,metadata,now()),filename,source);}
 async function commit(actor,key,hash,replace=false){return tx(actor,async c=>{
  const r=(await c.query('select * from content_meta_imports where id=$1 for update',[key])).rows[0];if(!r)throw fail('NOT_FOUND',404);if(r.sha256!==hash)throw fail('HASH_MISMATCH',409);if(r.status==='committed')return {import:importDto({...r,active:(await c.query('select exists(select 1 from content_meta_daily_sources where import_id=$1) active',[key])).rows[0].active}),alreadyImported:true};if(new Date(r.expires_at).getTime()<now().getTime())throw fail('PREVIEW_EXPIRED',409);
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[r.account_id+':'+r.level]);
  const overlap=(await c.query('select exists(select 1 from content_meta_daily_sources where account_id=$1 and level=$2 and day between $3 and $4) found',[r.account_id,r.level,r.from_day,r.to_day])).rows[0].found;if(overlap&&!replace)throw fail('OVERLAPPING_IMPORT',409);
  const previous=(await c.query('select distinct import_id from content_meta_daily_sources where account_id=$1 and level=$2 and day between $3 and $4',[r.account_id,r.level,r.from_day,r.to_day])).rows.map(x=>x.import_id);
  await c.query('insert into content_meta_daily_sources(account_id,level,day,import_id) select $1,$2,d::date,$3 from generate_series($4::date,$5::date,interval \'1 day\') d on conflict(account_id,level,day) do update set import_id=excluded.import_id',[r.account_id,r.level,key,r.from_day,r.to_day]);
  const saved=(await c.query("update content_meta_imports set status='committed',committed_at=now(),committed_by=$2 where id=$1 returning *",[key,actor])).rows[0];await c.query("insert into content_meta_audit(import_id,actor_id,action,details)values($1,$2,'commit',$3)",[key,actor,JSON.stringify({sha256:hash,replacedSources:previous,replace,from:r.from_day,to:r.to_day})]);return {import:importDto({...saved,active:true}),alreadyImported:false};
 });}
 const configured=()=>env.META_ADS_READ_ACCESS_TOKEN&&env.META_ADS_READ_ACCOUNT_ID===META_ACCOUNT&&/^v\d+\.\d+$/.test(env.META_ADS_READ_GRAPH_VERSION||'');
 async function graph(path,parameters){
  const url=new URL('https://graph.facebook.com/'+env.META_ADS_READ_GRAPH_VERSION+'/'+path);for(const [k,v]of Object.entries(parameters))url.searchParams.set(k,v);
  let response;try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:'Bearer '+env.META_ADS_READ_ACCESS_TOKEN,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw fail('META_READ_ACCESS_FAILED',503);}
  if(!response.ok)throw fail('META_READ_ACCESS_FAILED',409);const text=await response.text();if(text.length>20*1024*1024)throw fail('META_READ_TOO_MANY_ROWS',409);let data;try{data=JSON.parse(text);}catch{throw fail('META_READ_ACCESS_FAILED',503);}if(data.error)throw fail('META_READ_ACCESS_FAILED',409);return data;
 }
 return {
  preview,commit,
  async status(actor){return tx(actor,async c=>{const list=await imports(c);const api=list.find(r=>r.source==='meta_api'&&r.status==='committed');return {canRead:true,canImport:true,canSync:Boolean(configured()),connection:{status:!configured()?'not_configured':api?'connected':'configured',message:configured()?'Conexión de solo lectura configurada.':'Falta autorizar una conexión Meta con ads_read para esta cuenta. Los CSV funcionan de forma independiente.',lastSyncAt:api?.committed_at||null,timezone:META_TIMEZONE,currency:'USD',accountId:META_ACCOUNT},imports:list.map(importDto)};});},
  async original(actor,key){return tx(actor,async c=>{const r=(await c.query('select filename,raw_csv from content_meta_imports where id=$1',[key])).rows[0];if(!r)throw fail('NOT_FOUND',404);return r;});},
  async insights(actor,query={}){const level=query.level||'ad';if(!levels.has(level))throw fail('INVALID_LEVEL');for(const k of ['since','until'])if(query[k]&&!date(query[k]))throw fail('INVALID_DATE');for(const k of ['campaignId','adsetId','adId'])if(query[k]&&!id(query[k]))throw fail('INVALID_FILTER');if(query.since&&query.until&&query.since>query.until)throw fail('INVALID_DATE');
   return tx(actor,async c=>{const params=[META_ACCOUNT,level],where=['s.account_id=$1','s.level=$2'];for(const [key,col] of [['since','s.day>='],['until','s.day<='],['campaignId','r.campaign_id='],['adsetId','r.adset_id='],['adId','r.ad_id=']])if(query[key]){params.push(query[key]);where.push(col+'$'+params.length);}const explicitPartial=query.until; if(!explicitPartial)where.push('(i.partial_day is null or s.day<>i.partial_day)');
    const rows=(await c.query('select r.*,i.partial_day,i.committed_at,i.source,i.coverage from content_meta_daily_sources s join content_meta_imports i on i.id=s.import_id and i.status=\'committed\' join content_meta_rows r on r.import_id=s.import_id and r.day=s.day where '+where.join(' and ')+' order by r.day,r.entity_id',params)).rows;
    const all=(await c.query('select distinct r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,r.ad_id,r.entity_name from content_meta_daily_sources s join content_meta_rows r on r.import_id=s.import_id and r.day=s.day where s.account_id=$1 and s.level=$2',[META_ACCOUNT,level])).rows;
    const opts=(col,name)=>[...new Map(all.filter(x=>x[col]).map(x=>[x[col],{id:x[col],name:x[name]||x[col]}])).values()];
    const days=rows.map(r=>dayString(r.day)),partial=rows.some(r=>r.partial_day&&dayString(r.day)===dayString(r.partial_day));return {...aggregateMetaRows(rows),filters:{campaigns:opts('campaign_id','campaign_name'),adsets:opts('adset_id','adset_name'),ads:opts('ad_id','entity_name')},meta:{timezone:META_TIMEZONE,currency:'USD',partialDay:partial,level,updatedAt:rows.reduce((max,r)=>!max||r.committed_at>max?r.committed_at:max,null),source:rows.length?[...new Set(rows.map(r=>r.source))].join('+'):'none',from:query.since||days[0]||null,to:query.until||days.at(-1)||null,warnings:['Los niveles no se suman entre sí.','El alcance único del período no está disponible; no se suma el alcance diario.','Los resultados atribuidos por Meta no son ventas ni consultas verificadas del CRM.','Los campos vacíos no son cero. Los clics de enlace muestran únicamente los valores informados; su CTR no se calcula si faltan valores.',...new Set(rows.map(r=>r.coverage).filter(Boolean)),...(new Set(rows.map(r=>r.attribution).filter(Boolean)).size>1?['Los anuncios usan distintas ventanas de atribución. Los resultados se muestran por indicador y no equivalen a ventas del CRM.']:[]),...(partial?['El período incluye un día parcial.']:[])]}};
   });
  },
  async sync(actor,query={}){
   // Check the authenticated, persisted permission before making any Meta request.
   await tx(actor,async()=>null);if(!configured())throw fail('META_READ_CONNECTION_NOT_CONFIGURED',409);
   const today=pacificDay(now()),shift=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
   const since=query.since||shift(today,-7),until=query.until||shift(today,-1),level=query.level||'ad';if(!date(since)||!date(until)||since>until||until>=today||Date.parse(until)-Date.parse(since)>31*86400000||!levels.has(level))throw fail('INVALID_DATE');
   const account=await graph('act_'+META_ACCOUNT,{fields:'account_id,currency,timezone_name'});if(account.account_id!==META_ACCOUNT||account.currency!=='USD'||account.timezone_name!==META_TIMEZONE)throw fail('META_READ_ACCOUNT_MISMATCH',409);
   const fields=['account_id','campaign_id','campaign_name',...(level!=='campaign'?['adset_id','adset_name']:[]),...(level==='ad'?['ad_id','ad_name']:[]),'date_start','date_stop','spend','impressions','clicks','inline_link_clicks','reach','actions'].join(',');
   let after=null;const cursors=new Set(),records=[];do{
    const data=await graph('act_'+META_ACCOUNT+'/insights',{fields,level,time_increment:'1',time_range:JSON.stringify({since,until}),limit:'500',...(after?{after}:{}),action_report_time:'conversion',use_unified_attribution_setting:'true'});
    if(!Array.isArray(data.data))throw fail('META_READ_ACCESS_FAILED',503);records.push(...data.data);if(records.length>100000)throw fail('META_READ_TOO_MANY_ROWS',409);
    if(data.paging?.next){after=data.paging?.cursors?.after;if(typeof after!=='string'||after.length>2000||cursors.has(after)||cursors.size>=500)throw fail('META_READ_ACCESS_FAILED',503);cursors.add(after);}else after=null;
   }while(after);
   if(!records.length)throw fail('META_READ_NO_DELIVERY',409);
   const header=['Inicio del informe','Fin del informe','Identificador de la cuenta','Nombre de la campaña','Identificador de la campaña',...(level!=='campaign'?['Nombre del conjunto de anuncios','Identificador del conjunto de anuncios']:[]),...(level==='ad'?['Nombre del anuncio','Identificador del anuncio']:[]),'Monto gastado (USD)','Impresiones','Clics (todos)','Clics en el enlace','Alcance','Resultados','Indicador de resultado','Acciones API (JSON)'];
   const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
   const lines=records.map(r=>[r.date_start,r.date_stop,r.account_id,r.campaign_name,r.campaign_id,...(level!=='campaign'?[r.adset_name,r.adset_id]:[]),...(level==='ad'?[r.ad_name,r.ad_id]:[]),r.spend,r.impressions,r.clicks,r.inline_link_clicks,r.reach,'','',JSON.stringify(r.actions||[])]);
   const bytes=Buffer.from([header,...lines].map(r=>r.map(quote).join(',')).join('\n'));
   const d=normalizeMetaCsv(bytes,{exportedAt:now().toISOString(),partialDay:today,coverage:'Insights GET completo con paginación. action_report_time=conversion; atribución unificada del conjunto.'},now());
   for(let i=0;i<d.rows.length;i++){const actions={};for(const action of records[i].actions||[]){if(typeof action.action_type!=='string'||!/^[a-zA-Z0-9_.:]{1,180}$/.test(action.action_type))throw fail('INVALID_ACTION_TYPE');const value=decimal(String(action.value??''));const key='actions:'+action.action_type;if(key in actions)throw fail('DUPLICATE_ACTION');actions[key]=value;}d.rows[i].actions=actions;}
   const p=await stage(actor,d,'Meta_Insights_'+level+'_'+since+'_'+until+'.csv','meta_api');return commit(actor,p.previewId,p.hash,true);
  },
 };
}
