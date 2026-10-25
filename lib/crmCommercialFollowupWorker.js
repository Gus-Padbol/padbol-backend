import {randomUUID} from 'node:crypto';
const hours=[48,120,192],uuid=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
export function readCommercialFollowupConfig(env={}){
 let templates;try{templates=JSON.parse(env.CRM_COMMERCIAL_FOLLOWUP_TEMPLATES_JSON||'null');}catch{}
 const validTemplates=Boolean(templates&&['es','en'].every(lang=>Array.isArray(templates[lang])&&templates[lang].length===3&&templates[lang].every(t=>t&&/^[a-z0-9_]{1,512}$/.test(t.name)&&new RegExp('^'+lang+'(?:_[A-Z]{2})?$').test(t.languageCode)&&typeof t.body==='string'&&t.body.trim().length>10&&t.body.length<=4096&&!t.body.includes('{{'))));
 const credentials=env.BACKEND_RUNTIME_MODE==='production'&&env.OUTBOUND_DELIVERY_ENABLED==='true'&&env.CRM_WHATSAPP_PHONE_NUMBER_ID==='1376102838911694'&&env.CRM_WHATSAPP_WABA_ID==='928900479733370'&&env.CRM_WHATSAPP_CHANNEL_ID==='1bad838f-b5cc-4ae4-b28d-e63c998c6474'&&uuid.test(env.CRM_WHATSAPP_ORGANIZATION_ID||'')&&/^v\d{1,3}\.0$/.test(env.WHATSAPP_META_GRAPH_VERSION||'')&&Boolean(String(env.CRM_WHATSAPP_ACCESS_TOKEN||'').trim());
 return {templates,validTemplates,credentials,enabled:credentials&&validTemplates&&env.CRM_COMMERCIAL_FOLLOWUP_ENABLED==='true'&&env.CRM_COMMERCIAL_FOLLOWUP_SECURITY_APPROVED==='true'};
}
export function createCommercialFollowupRuntime({pool,db,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),intervalMs=60000,logger=console}={}){
 const config=readCommercialFollowupConfig(env);let timer=null,armed=false,busy=false,cache=null;
 const enabled=()=>config.enabled&&env.CRM_COMMERCIAL_FOLLOWUP_ENABLED==='true'&&env.CRM_COMMERCIAL_FOLLOWUP_SECURITY_APPROVED==='true';
 const result=(reason,extra={})=>({ready:false,enabled:enabled()&&armed,templatesReady:false,reason,scheduleHours:hours,...extra});
 async function inspect(){
  if(!pool?.query||!db?.from||typeof fetchImpl!=='function')return result('El servicio de seguimientos todavía no está disponible.');
  if(!config.validTemplates)return result('Las plantillas de seguimiento todavía no están configuradas.');
  if(!config.credentials||!enabled()||!armed)return result('El envío automático de seguimientos todavía no está habilitado.');
  try{
   const schema=(await pool.query("select to_regprocedure('public.crm_commercial_followup_enable(uuid,boolean,text,uuid,text,text,text)') is not null and to_regclass('public.crm_commercial_followup_dispatches') is not null as ready")).rows[0];
   if(!schema?.ready)return result('La preparación del seguimiento todavía no está completa.');
   const channel=await db.from('whatsapp_tenant_channels').select('id,meta_phone_number_id,meta_waba_id,credential_ref,active,whatsapp_tenants!inner(status,organization_id)').eq('id',env.CRM_WHATSAPP_CHANNEL_ID).eq('meta_phone_number_id',env.CRM_WHATSAPP_PHONE_NUMBER_ID).eq('meta_waba_id',env.CRM_WHATSAPP_WABA_ID).eq('credential_ref','PRODUCTION').eq('active',true).eq('whatsapp_tenants.status','active').eq('whatsapp_tenants.organization_id',env.CRM_WHATSAPP_ORGANIZATION_ID).maybeSingle();
   if(channel.error||!channel.data)return result('El canal de WhatsApp todavía necesita verificarse.');
   if(!cache||now()-cache.at>(cache.approved?5*60*1000:30000)){
    const all=[];let after=null;
    for(let page=0;page<20;page++){
     const u=new URL(`https://graph.facebook.com/${env.WHATSAPP_META_GRAPH_VERSION}/${env.CRM_WHATSAPP_WABA_ID}/message_templates`);u.searchParams.set('fields','name,status,language,category,components');u.searchParams.set('limit','100');if(after)u.searchParams.set('after',after);
     const r=await fetchImpl(u.toString(),{headers:{Authorization:`Bearer ${env.CRM_WHATSAPP_ACCESS_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok||r.redirected)throw Error('verification');const data=await r.json();if(!Array.isArray(data.data))throw Error('verification');all.push(...data.data);if(!data.paging?.next)break;after=data.paging?.cursors?.after;if(!after||page===19)throw Error('verification');
    }
    const approved=['es','en'].every(lang=>config.templates[lang].every(t=>all.some(a=>a.name===t.name&&a.language===t.languageCode&&a.status==='APPROVED'&&a.category==='MARKETING'&&a.components?.length===1&&a.components[0].type==='BODY'&&a.components[0].text?.trim()===t.body.trim())));
    cache={at:now(),approved};
   }
   if(!cache.approved)return result('Meta todavía no aprobó todas las plantillas de seguimiento, o su texto necesita revisión.');
   return result('El seguimiento está listo para activarse con autorización del contacto.',{ready:true,templatesReady:true});
  }catch{return result('No se pudo verificar la preparación del seguimiento. Intenta nuevamente más tarde.');}
 }
 async function readiness({user,superadmin=false,type,caseId,language='es',templateKey}={}){
  const configured=await inspect();if(!configured.ready)return configured;
  if(!['es','en'].includes(language)||templateKey&&templateKey!==`commercial_waiting_${language}_v1`)return {...configured,ready:false,reason:'El plan de mensajes no coincide con las plantillas de seguimiento aprobadas.'};
  try{const r=await pool.query('select public.crm_commercial_followup_info($1,$2,$3,$4) info',[user?.id,superadmin,type,caseId]);const info=r.rows[0]?.info;if(info?.eligible!==true){const reasons={conversation_closed:'La conversación está cerrada. Reábrela antes de planificar un nuevo seguimiento.',waiting_state_required:'Guarda la consulta en espera antes de activar el seguimiento.',recipient_not_verified:'Falta un número de WhatsApp confirmado para este contacto.',opted_out:'Este contacto pidió dejar de recibir seguimientos.',call_summary_required:'Completa y guarda el resumen de la conversación antes de activar el seguimiento.',another_followup_active:'Este contacto ya tiene un seguimiento activo en otra consulta.',send_requires_review:'Hay un envío pendiente de confirmar. Revísalo antes de activar nuevos mensajes.',case_unavailable:'La consulta no está disponible para este acceso.'};return {...configured,ready:false,reason:reasons[info?.reason]||'La consulta todavía no reúne las condiciones para activar el seguimiento.'};}return configured;}catch{return {...configured,ready:false,reason:'No se pudo verificar la consulta antes de activar el seguimiento.'};}
 }
 async function markUncertain(planId,attemptId){const c=await pool.connect();try{await c.query('begin');const p=(await c.query('select conversation_id from public.crm_commercial_followups where id=$1',[planId])).rows[0];if(p){await c.query('select id from public.crm_conversations where id=$1 for update',[p.conversation_id]);await c.query('select id from public.crm_commercial_followups where id=$1 for update',[planId]);const r=await c.query("update public.crm_commercial_followup_dispatches set status='uncertain',updated_at=now() where id=$1 and status in ('reserved','dispatching') returning id",[attemptId]);if(r.rowCount)await c.query("update public.crm_commercial_followups set status='paused',dispatch_enabled=false,paused_at=now(),paused_reason='send_uncertain' where id=$1",[planId]);}await c.query('commit');}catch{try{await c.query('rollback');}catch{}logger?.error?.('[commercial-followup]',{code:'UNCERTAIN_REQUIRES_REVIEW'});}finally{c.release();}}
 async function dispatch(plan,step,t){
  const claimToken=randomUUID();const reserved=(await pool.query('select public.crm_commercial_followup_claim($1,$2,$3,$4,$5,$6,$7) info',[plan.id,step,new Date(now()).toISOString(),t.name,t.languageCode,t.body,claimToken])).rows[0]?.info;
  if(!reserved)return {status:'skipped'}; // Durable commit is complete before any HTTP request.
  const c=await pool.connect();let transaction=false,released=false;
  try{
   await c.query('begin');transaction=true;
   const checked=(await c.query('select public.crm_commercial_followup_check($1,$2,$3,$4) info',[plan.id,step,new Date(now()).toISOString(),reserved.attemptId])).rows[0]?.info;
   const attempt=(await c.query('select * from public.crm_commercial_followup_dispatches where id=$1 and claim_token=$2 for update',[reserved.attemptId,claimToken])).rows[0];
   if(!checked||attempt?.status!=='reserved'||!enabled()){await c.query("update public.crm_commercial_followup_dispatches set status='cancelled',updated_at=now() where id=$1 and claim_token=$2 and status='reserved'",[reserved.attemptId,claimToken]);await c.query("update public.crm_commercial_followups set status='paused',dispatch_enabled=false,paused_at=now(),paused_reason='dispatch_cancelled' where id=$1 and status='active'",[plan.id]);await c.query('commit');transaction=false;return {status:'cancelled'};}
   await c.query("update public.crm_commercial_followup_dispatches set status='dispatching',updated_at=now() where id=$1",[attempt.id]);
   let providerId;
   try{
    const r=await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_META_GRAPH_VERSION}/${env.CRM_WHATSAPP_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${env.CRM_WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(10000),body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:checked.recipient,type:'template',template:{name:attempt.template_name,language:{code:attempt.language_code}}})});
    const data=await r.json();providerId=data.messages?.[0]?.id;if(!r.ok||r.redirected||typeof providerId!=='string'||!providerId||providerId.length>512)throw Error('uncertain');
   }catch{await c.query("update public.crm_commercial_followup_dispatches set status='uncertain',updated_at=now() where id=$1",[attempt.id]);await c.query("update public.crm_commercial_followups set status='paused',dispatch_enabled=false,paused_at=now(),paused_reason='send_uncertain' where id=$1",[plan.id]);await c.query('commit');transaction=false;return {status:'uncertain'};}
   await c.query("select set_config('padbol.commercial_followup_dispatch',$1,true)",[attempt.id]);
   const receipt=await c.query("insert into public.crm_replies(id,conversation_id,body,operador,status,provider_message_id)values($1,$2,$3,'automation:commercial_followup','sent',$4)on conflict do nothing returning id",[attempt.id,reserved.conversationId,attempt.body,providerId]);if(receipt.rowCount!==1)throw Error('receipt');
   await c.query("update public.crm_commercial_followup_dispatches set status='accepted',provider_message_id=$2,accepted_at=$3,updated_at=$3 where id=$1",[attempt.id,providerId,new Date(now()).toISOString()]);
   await c.query("insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details)select started_by,'followup_step_accepted',id,jsonb_build_object('step',$2::int,'attempt_id',$3::text,'provider_message_id',$4::text)from public.crm_commercial_followups where id=$1",[plan.id,step,attempt.id,providerId]);
   if(step===3)await c.query("update public.crm_commercial_followups set status='completed',dispatch_enabled=false where id=$1",[plan.id]);
   await c.query('commit');transaction=false;return {status:'accepted',step};
  }catch{if(transaction)try{await c.query('rollback');}catch{}c.release();released=true;await markUncertain(plan.id,reserved.attemptId);return {status:'uncertain'};}finally{if(!released)c.release();}
 }
 async function runOnce(){
  if(busy||!enabled()||!armed)return {processed:0};busy=true;
  try{
   if(!(await inspect()).ready)return {processed:0};
   const plans=(await pool.query(`select f.id,f.language,f.template_key from public.crm_commercial_followups f
    cross join lateral(select count(*)filter(where status='accepted')::int accepted,max(accepted_at)filter(where status='accepted') last_sent,min(created_at)filter(where status in ('reserved','dispatching')) pending_since,bool_or(status<>'accepted') blocked from public.crm_commercial_followup_dispatches where plan_id=f.id)a
    cross join lateral(select f.started_at+case a.accepted when 0 then interval '48 hours' when 1 then interval '120 hours' else interval '192 hours' end due)d
    where f.status='active' and f.dispatch_enabled=true and (a.pending_since<=$1::timestamptz-interval '15 minutes' or (not coalesce(a.blocked,false) and a.accepted<3 and d.due<=$1::timestamptz and (a.last_sent is null or a.last_sent+interval '72 hours'<=$1::timestamptz)))
    order by coalesce(a.pending_since,d.due),f.id limit 50`,[new Date(now()).toISOString()])).rows;const results=[];
   for(const plan of plans){
    if(!enabled())break;
    const step=Number((await pool.query("select count(*)::int n from public.crm_commercial_followup_dispatches where plan_id=$1 and status='accepted'",[plan.id])).rows[0].n)+1;if(step>3)continue;
    const existing=(await pool.query('select id,status,created_at from public.crm_commercial_followup_dispatches where plan_id=$1 and step=$2',[plan.id,step])).rows[0];
    if(existing){if(['reserved','dispatching'].includes(existing.status)&&now()-Date.parse(existing.created_at)>15*60*1000)await markUncertain(plan.id,existing.id);continue;}
    const t=config.templates[plan.language]?.[step-1];if(!t||plan.template_key!==`commercial_waiting_${plan.language}_v1`)continue;
    results.push(await dispatch(plan,step,t));
   }
   return {processed:results.filter(r=>r.status==='accepted').length,results};
  }catch{logger?.error?.('[commercial-followup]',{code:'WORKER_NOT_READY'});return {processed:0};}finally{busy=false;}
 }
 function start(){if(!enabled()||timer)return false;armed=true;timer=setInterval(()=>{void runOnce();},intervalMs);timer.unref?.();return true;}
 function stop(){if(timer)clearInterval(timer);timer=null;armed=false;}
 return {start,stop,readiness,runOnce,inspect};
}
