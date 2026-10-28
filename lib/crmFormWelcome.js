import {randomUUID} from 'node:crypto';
import {normalizePhone} from './crmContact.js';
import {WELCOME_CONSENT_TEXT,WELCOME_CONSENT_VERSION} from './crmWelcomeConsentCandidate.js';
import {readCommercialFollowupConfig} from './crmCommercialFollowupWorker.js';
export const FORM_WELCOME_TEMPLATES = {
 es:{name:'padbol_contacto_chivi_es_v1',body:'Hola, {{1}}. Somos el equipo de Padbol International.\n\nYa recibimos tu consulta y nos pondremos en contacto contigo lo antes posible para conversar sobre tu proyecto.\n\nSi quieres, puedes indicarnos qué días y horarios te resultan más cómodos para hablar. Cuanto más amplia sea tu disponibilidad, más fácil será coordinar una conversación.\n\nMientras tanto, si quieres conocer más sobre Padbol o resolver algunas dudas, puedes conversar por aquí con Chivi, nuestro asistente virtual.\n\n¿Qué te gustaría saber?'},
 en:{name:'padbol_contacto_chivi_en_v1',body:'Hello, {{1}}. We are the Padbol International team.\n\nWe have received your enquiry and will contact you as soon as possible to talk about your project.\n\nIf you would like, please let us know which days and times work best for you. The wider your availability, the easier it will be to arrange a conversation.\n\nIn the meantime, if you would like to learn more about Padbol or have any questions, you can chat here with Chivi, our virtual assistant.\n\nWhat would you like to know?'}
};
export function welcomeConsentValid(row,now=Date.now()) {
 const c=row?.qualification_data?.whatsapp_contact_consent,p=normalizePhone(c?.phone),at=Date.parse(c?.acceptedAt);
 return Boolean(c?.accepted===true&&c.version===WELCOME_CONSENT_VERSION&&Object.hasOwn(WELCOME_CONSENT_TEXT,c.language)
  &&c.text===WELCOME_CONSENT_TEXT[c.language]&&c.source==='web:contacto'&&c.purpose==='consultation_followup'
  &&p&&/^[1-9][0-9]{7,14}$/.test(p)&&p===row.phone_normalized&&row.review_needed===false
  &&Number.isFinite(at)&&at<=now&&now-at<=1800000);
}
const query=`select c.id conversation_id,c.contact_id,c.qualification_data,co.phone_normalized,co.nombre,co.review_needed,e.id event_id
 from public.crm_conversations c join public.crm_contacts co on co.id=c.contact_id
 join public.crm_inbound_events e on e.conversation_id=c.id and e.source_channel='email' and e.origin=c.origin and e.source_ref=c.source_ref
 where c.source_channel='email' and c.origin like 'web_form:%' and public.crm_commercial_form_is_allowed(c.id)
 and c.qualification_data->'whatsapp_contact_consent'->>'accepted'='true'
 and c.qualification_data->'whatsapp_contact_consent'->>'version'='contacto-whatsapp-consulta-v1'
 and c.qualification_data->'whatsapp_contact_consent'->>'language' in ('es','en')
 and c.estado='nuevo' and c.operador is null and not c.derivado and not co.review_needed
 and c.created_at >= $1::timestamptz and e.created_at >= $1::timestamptz and e.created_at >= $2::timestamptz-interval '30 minutes'

 and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=c.id and f.progress_state='nuevo')
 and not exists(select 1 from public.crm_commercial_team_calls calls where calls.conversation_id=c.id)
 and not exists(select 1 from public.crm_activities a where a.conversation_id=c.id and a.author<>'automation:form_welcome')
 and not exists(select 1 from public.crm_replies r where r.conversation_id=c.id)
 and not exists(select 1 from public.crm_commercial_followup_optouts o where o.recipient_wa_id=co.phone_normalized)`;
export function createFormWelcomeRuntime({pool,db,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),logger=console}={}) {
 let busy=false,timer=null,cache=null;
 const since=Date.parse(env.CRM_FORM_WELCOME_ENABLED_SINCE||'');
 const enabled=()=>env.CRM_FORM_WELCOME_ENABLED==='true'&&Number.isFinite(since)&&readCommercialFollowupConfig(env).credentials
  &&env.WHATSAPP_PRODUCTION_MENU_ENABLED==='true'&&env.WHATSAPP_COMMERCIAL_CHIVI_WAIT_ENABLED==='true';
 const dates=()=>[new Date(since).toISOString(),new Date(now()).toISOString()];
 async function inspect(){
  if(!enabled()||!pool?.query||!db?.from)return {ready:false,reason:'not_configured'};
  try{
   if(!(await pool.query("select to_regclass('public.crm_form_welcome_dispatches') is not null ready")).rows[0]?.ready)return {ready:false,reason:'schema_missing'};
   const channel=await db.from('whatsapp_tenant_channels').select('id,whatsapp_tenants!inner(status,organization_id)').eq('id',env.CRM_WHATSAPP_CHANNEL_ID).eq('meta_phone_number_id',env.CRM_WHATSAPP_PHONE_NUMBER_ID).eq('meta_waba_id',env.CRM_WHATSAPP_WABA_ID).eq('credential_ref','PRODUCTION').eq('active',true).eq('whatsapp_tenants.status','active').eq('whatsapp_tenants.organization_id',env.CRM_WHATSAPP_ORGANIZATION_ID).maybeSingle();
   if(channel.error||!channel.data)return {ready:false,reason:'channel_unavailable'};
   if(!cache||now()-cache.at>60000){
    const u=new URL(`https://graph.facebook.com/${env.WHATSAPP_META_GRAPH_VERSION}/${env.CRM_WHATSAPP_WABA_ID}/message_templates`);
    u.searchParams.set('fields','name,status,language,category,components');u.searchParams.set('limit','100');const all=[];
    for(let page=0;page<20;page++){
     const r=await fetchImpl(u,{headers:{Authorization:`Bearer ${env.CRM_WHATSAPP_ACCESS_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(10000)});
     if(!r.ok||r.redirected)throw Error('templates');const j=await r.json();if(!Array.isArray(j.data))throw Error('templates');all.push(...j.data);
     if(!j.paging?.next)break;if(page===19||!j.paging?.cursors?.after)throw Error('pagination');u.searchParams.set('after',j.paging.cursors.after);
    }
    cache={at:now(),approved:Object.entries(FORM_WELCOME_TEMPLATES).every(([lang,t])=>all.some(a=>a.name===t.name&&a.language===lang&&a.status==='APPROVED'&&a.category==='MARKETING'&&a.components?.length===1&&a.components[0].type==='BODY'&&a.components[0].text===t.body))};
   }
   return {ready:cache.approved,reason:cache.approved?'ready':'templates_not_approved'};
  }catch{return {ready:false,reason:'verification_failed'};}
 }
 async function dispatch(row){
  const id=randomUUID(),consent=row.qualification_data.whatsapp_contact_consent,t=FORM_WELCOME_TEMPLATES[consent.language];
  const name=String(row.nombre||(consent.language==='en'?'there':'hola')).replace(/[\r\n\t]+/g,' ').trim().slice(0,80);
  // Unique recipient + event: durable claim precedes the provider call. Never
  // automatically retry an ambiguous result, including a process interruption.
  const claim=await pool.query(`insert into public.crm_form_welcome_dispatches(id,conversation_id,event_id,recipient_wa_id,language,consent,template_name,body,status)
   values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'reserved') on conflict do nothing returning id`,[id,row.conversation_id,row.event_id,row.phone_normalized,consent.language,JSON.stringify(consent),t.name,t.body.replace('{{1}}',name)]);
  if(!claim.rowCount)return 'skipped';
  const c=await pool.connect();let inTx=false;
  try{
   await c.query('begin');inTx=true;await c.query('select id from public.crm_conversations where id=$1 for update',[row.conversation_id]);
   await c.query('select id from public.crm_contacts where id=$1 for update',[row.contact_id]);
   const current=(await c.query(query+' and c.id=$3',[...dates(),row.conversation_id])).rows.find(v=>v.event_id===row.event_id);
   if(!enabled()||!welcomeConsentValid(current,now())||JSON.stringify(current.qualification_data.whatsapp_contact_consent)!==JSON.stringify(consent)){
    await c.query("update public.crm_form_welcome_dispatches set status='cancelled',updated_at=now() where id=$1",[id]);await c.query('commit');inTx=false;return 'cancelled';
   }
   await c.query("update public.crm_form_welcome_dispatches set status='dispatching',updated_at=now() where id=$1",[id]);
   let providerId;
   try{
    const r=await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_META_GRAPH_VERSION}/${env.CRM_WHATSAPP_PHONE_NUMBER_ID}/messages`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${env.CRM_WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:row.phone_normalized,type:'template',template:{name:t.name,language:{code:consent.language},components:[{type:'body',parameters:[{type:'text',text:name}]}]}})});
    const j=await r.json();providerId=j.messages?.[0]?.id;if(!r.ok||r.redirected||typeof providerId!=='string'||!providerId||providerId.length>512)throw Error('send');
   }catch{
    await c.query("update public.crm_form_welcome_dispatches set status='uncertain',updated_at=now() where id=$1",[id]);await c.query('commit');inTx=false;return 'uncertain';
   }
   await c.query("update public.crm_form_welcome_dispatches set status='accepted',provider_message_id=$2,accepted_at=$3,updated_at=$3 where id=$1",[id,providerId,new Date(now()).toISOString()]);
   await c.query("insert into public.crm_activities(contact_id,conversation_id,activity_type,summary,author) values($1,$2,'note',$3,'automation:form_welcome')",[row.contact_id,row.conversation_id,consent.language==='en'?'WhatsApp welcome accepted by the messaging provider. Human contact remains pending.':'Bienvenida por WhatsApp aceptada por el proveedor de mensajería. El contacto humano sigue pendiente.']);
   await c.query('commit');inTx=false;return 'accepted';
  }catch{
   if(inTx)try{await c.query('rollback');}catch{}
   // Release the client before the recovery write (also works with a pool of one).
   c.release();inTx=null;
   try{await pool.query("update public.crm_form_welcome_dispatches set status='uncertain',updated_at=now() where id=$1 and status in ('reserved','dispatching')",[id]);}catch{}
   return 'uncertain';
  }finally{if(inTx!==null)c.release();}
 }
 async function runOnce(){
  if(busy||!enabled())return {processed:0};busy=true;
  try{
   if(!(await inspect()).ready)return {processed:0};
   await pool.query("update public.crm_form_welcome_dispatches set status='uncertain',updated_at=now() where status in ('reserved','dispatching') and created_at<now()-interval '15 minutes'");
   const rows=(await pool.query(query+` and not exists(select 1 from public.crm_form_welcome_dispatches w where w.recipient_wa_id=co.phone_normalized) order by e.created_at,e.id limit 20`,dates())).rows;
   let processed=0;for(const row of rows){if(!enabled())break;if(welcomeConsentValid(row,now())&&await dispatch(row)==='accepted')processed++;}return {processed};
  }catch{logger?.error?.('[form-welcome]',{code:'WELCOME_UNAVAILABLE'});return {processed:0};}finally{busy=false;}
 }
 return {inspect,runOnce,start(){if(!enabled()||timer)return false;timer=setInterval(()=>void runOnce(),60000);timer.unref?.();return true;},stop(){clearInterval(timer);timer=null;}};
}

// Only an actual accepted welcome can establish context. Neither a browser
// flag nor an arbitrary phone lookup grants access to a commercial case.
export function createFormWelcomeContextResolver({pool,env=process.env}={}) {
 return async ({phoneNumberId,fromWaId})=>{
  if(env.CRM_FORM_WELCOME_ENABLED!=='true'||phoneNumberId!=='1376102838911694'||!/^[1-9][0-9]{7,14}$/.test(fromWaId||'')||!pool?.query)return null;
  try{
   const row=(await pool.query(`select w.language,w.conversation_id from public.crm_form_welcome_dispatches w
    join public.crm_conversations c on c.id=w.conversation_id join public.crm_contacts co on co.id=c.contact_id
    where w.recipient_wa_id=$1 and w.status='accepted' and w.accepted_at>now()-interval '14 days'
    and co.phone_normalized=w.recipient_wa_id and not co.review_needed and c.estado='nuevo' and c.operador is null and not c.derivado
    and c.qualification_data->'whatsapp_contact_consent'=w.consent
   
 and exists(select 1 from public.crm_commercial_form_cases f where f.conversation_id=c.id and f.progress_state='nuevo')
 and not exists(select 1 from public.crm_commercial_team_calls calls where calls.conversation_id=c.id)
 and not exists(select 1 from public.crm_activities a where a.conversation_id=c.id and a.author<>'automation:form_welcome')
 and not exists(select 1 from public.crm_replies r where r.conversation_id=c.id)
    and not exists(select 1 from public.crm_commercial_followup_optouts o where o.recipient_wa_id=w.recipient_wa_id)
    limit 1`,[fromWaId])).rows[0];
   return row&&['es','en'].includes(row.language)?{language:row.language,formConversationId:row.conversation_id}:null;
  }catch{return null;}
 };
}
