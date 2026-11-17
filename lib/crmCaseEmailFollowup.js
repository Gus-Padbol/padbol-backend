import {randomUUID} from 'node:crypto';
import {sequenceSteps, renderSequenceMessage, classifyProspectReply, unsubscribeUrlFor} from './crmProspectSequence.js';
export const CASE_EMAIL_STEP_DAYS=Object.freeze([0,7,14]);
const fail=(code,message,status=400)=>Object.assign(new Error(message||code),{code,status});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const days=step=>new Date(Date.parse('2026-01-01T00:00:00Z')+step*86400000);
function dueAt(started,step){return new Date(new Date(started).getTime()+CASE_EMAIL_STEP_DAYS[step]*86400000);}
function validStop(r){return ['reply','meeting','closed','optout','bounce','manual'].includes(String(r||''));}
async function table(c,name){return (await c.query("select to_regclass($1) t",[`public.${name}`])).rows[0]?.t;}
async function caseContext(c,caseType,caseId,conversationId){
 const tableName=caseType==='form'?'crm_commercial_form_cases':'crm_commercial_cases';
 const idCol=caseType==='form'?'conversation_id':'id';
 if(!await table(c,tableName))throw fail('CASE_TABLE_MISSING','Tabla comercial no disponible',503);
 const r=(await c.query(`select k.progress_state,k.conversation_id,c.estado,cv.email_normalized contact_email from public.${tableName} k join public.crm_conversations c on c.id=k.conversation_id join public.crm_contacts cv on cv.id=c.contact_id where k.${idCol}=$1 for update`,[caseId])).rows[0];
 if(!r)throw fail('CASE_NOT_FOUND','Caso comercial no encontrado',404);
 if(conversationId&&String(r.conversation_id)!==String(conversationId))throw fail('CASE_CONVERSATION_MISMATCH','Conversación no coincide');
 if(r.progress_state!=='en_espera')throw fail('CASE_NOT_WAITING','El plan sólo se activa desde En espera');
 if(!email.test(String(r.contact_email||'')))throw fail('EMAIL_REQUIRED','Correo verificado requerido en el caso');
 return {conversationId:r.conversation_id,email:r.contact_email,state:r.progress_state,conversationState:r.estado};
}
async function suppressed(c,address){
 if(!await table(c,'crm_prospect_suppressions'))return false;
 return (await c.query("select 1 from public.crm_prospect_suppressions where active=true and email is not null and lower(email)=lower($1) limit 1",[address])).rowCount>0;
}
async function activeWhatsappPlan(c,conversationId){
 if(!await table(c,'crm_commercial_followups'))return false;
 return (await c.query("select 1 from public.crm_commercial_followups where status='active' and conversation_id=$1 limit 1",[conversationId])).rowCount>0;
}
export function createCaseEmailFollowup({pool,sendEmail,now=()=>new Date(),logger=console}={}){
 if(!pool?.query)throw fail('POOL_REQUIRED','Falta pool');
 if(typeof sendEmail!=='function')throw fail('SENDER_REQUIRED','Falta sender');
 async function activatePlan({caseType,caseId,conversationId,recipientEmail,language='es',consentEvidence,startedAt=new Date(),createdBy,explicitHuman=false}={}){
  if(!['form','whatsapp'].includes(caseType)||!uuid.test(String(caseId||''))||!uuid.test(String(conversationId||'')))throw fail('INVALID_CASE','Caso inválido');
  if(explicitHuman!==true)throw fail('EXPLICIT_HUMAN_REQUIRED','La activación requiere transición humana explícita');
  if(!email.test(String(recipientEmail||''))||!['es','en'].includes(language))throw fail('EMAIL_OR_LANGUAGE_REQUIRED','Correo/idioma inválido');
  if(typeof consentEvidence!=='string'||!consentEvidence.trim()||consentEvidence.length>2000)throw fail('CONSENT_REQUIRED','Evidencia de permiso requerida');
  const at=new Date(startedAt);if(!Number.isFinite(at.getTime()))throw fail('START_REQUIRED','Inicio inválido');
  const c=await pool.connect();let tx=false;
  try{await c.query('begin');tx=true;
   const ctx=await caseContext(c,caseType,caseId,conversationId);
   if(String(ctx.email).toLowerCase()!==String(recipientEmail).toLowerCase())throw fail('EMAIL_MISMATCH','El correo no coincide con el caso');
   if(await suppressed(c,ctx.email))throw fail('SUPPRESSED','Correo suprimido');
   const existing=(await c.query("select id,status from public.crm_case_email_followup_plans where case_type=$1 and case_id=$2 and status in ('active','paused','human_review') for update",[caseType,caseId])).rows[0];
   if(existing){await c.query('commit');tx=false;return {status:existing.status,planId:existing.id,repeated:true,nextAt:null};}
   const plan=(await c.query(`insert into public.crm_case_email_followup_plans(case_type,case_id,conversation_id,recipient_email,language,status,started_at,consent_evidence,created_by) values($1,$2,$3,$4,$5,'active',$6,$7,$8) returning *`,[caseType,caseId,ctx.conversationId,ctx.email,language,at.toISOString(),consentEvidence.trim(),createdBy||null])).rows[0];
   for(let step=0;step<3;step++)await c.query("insert into public.crm_case_email_followup_outbox(plan_id,step,due_at) values($1,$2,$3) on conflict(plan_id,step) do nothing",[plan.id,step,dueAt(at,step).toISOString()]);
   await c.query('commit');tx=false;return {status:'active',planId:plan.id,repeated:false,nextAt:dueAt(at,0).toISOString(),recipient:ctx.email};
  }catch(e){if(tx)try{await c.query('rollback');tx=false;}catch{}if(e?.code==='23505'){const exists=(await pool.query("select id,status from public.crm_case_email_followup_plans where case_type=$1 and case_id=$2 and status in ('active','paused','human_review') limit 1",[caseType,caseId])).rows[0];if(exists)return {status:exists.status,planId:exists.id,repeated:true,nextAt:null};}throw e;}finally{c.release();}
 }
 async function stopPlan({planId,reason='manual'}={}){
  if(!uuid.test(String(planId||''))||!validStop(reason))throw fail('STOP_INVALID','Plan/motivo inválido');
  const c=await pool.connect();try{await c.query('begin');const p=(await c.query('select id from public.crm_case_email_followup_plans where id=$1 for update',[planId])).rows[0];if(!p)throw fail('PLAN_NOT_FOUND','Plan no encontrado',404);await c.query("update public.crm_case_email_followup_plans set status='stopped',updated_at=now() where id=$1",[planId]);await c.query("update public.crm_case_email_followup_outbox set status='cancelled',updated_at=now() where plan_id=$1 and status in ('queued','claimed')",[planId]);await c.query('commit');return {status:'stopped',reason};}catch(e){try{await c.query('rollback');}catch{}throw e;}finally{c.release();}
 }
 async function recoverStale({olderThanMinutes=15}={}){
  const c=await pool.connect();try{await c.query('begin');await c.query("update public.crm_case_email_followup_outbox set status='failed',error_code='CLAIM_UNCERTAIN',updated_at=now() where status='claimed' and claimed_at<now()-($1::int*interval '1 minute')",[olderThanMinutes]);await c.query("update public.crm_case_email_followup_plans p set status='paused',updated_at=now() where status='active' and exists(select 1 from public.crm_case_email_followup_outbox o where o.plan_id=p.id and o.status='failed' and o.error_code='CLAIM_UNCERTAIN')");await c.query('commit');return {status:'recovered'};}catch(e){try{await c.query('rollback');}catch{}throw e;}finally{c.release();}
 }
 async function claimDispatch({limit=10}={}){
  const client=await pool.connect();try{await client.query('begin');const rows=(await client.query(`select o.id,o.plan_id,o.step,o.due_at,p.case_type,p.case_id,p.conversation_id,p.recipient_email,p.language,p.started_at from public.crm_case_email_followup_outbox o join public.crm_case_email_followup_plans p on p.id=o.plan_id where o.status='queued' and o.due_at<=$1 and p.status='active' and not exists(select 1 from public.crm_case_email_followup_outbox prior where prior.plan_id=o.plan_id and prior.step<o.step and prior.status<>'accepted') order by o.plan_id,o.step for update of o skip locked limit $2`,[now().toISOString(),Math.max(1,Math.min(50,Number(limit)||10))])).rows;const out=[];for(const row of rows){const token=randomUUID();const up=await client.query("update public.crm_case_email_followup_outbox set status='claimed',claim_token=$2,claimed_at=now(),attempts=attempts+1,updated_at=now() where id=$1 and status='queued' returning *",[row.id,token]);if(up.rowCount)out.push({...row,claimToken:token});}await client.query('commit');return out;}catch(e){try{await client.query('rollback');}catch{}throw e;}finally{client.release();}
 }
 async function deliver({dispatch}={}){
  if(!dispatch?.claimToken)throw fail('CLAIM_REQUIRED','Claim requerido');
  const c=await pool.connect();try{await c.query('begin');const row=(await c.query(`select o.*,p.recipient_email,p.language,p.case_type,p.case_id,p.conversation_id,p.status plan_status from public.crm_case_email_followup_outbox o join public.crm_case_email_followup_plans p on p.id=o.plan_id where o.id=$1 and o.claim_token=$2 and o.status='claimed' and p.status='active' for update`,[dispatch.id,dispatch.claimToken])).rows[0];if(!row){await c.query('rollback');return {status:'cancelled'};}
   const ctx=await caseContext(c,row.case_type,row.case_id,row.conversation_id);
   if(ctx.state!=='en_espera'||ctx.conversationState==='cerrado'){await c.query("update public.crm_case_email_followup_plans set status='stopped',updated_at=now() where id=$1",[row.plan_id]);await c.query("update public.crm_case_email_followup_outbox set status='cancelled',updated_at=now() where plan_id=$1 and status='queued'",[row.plan_id]);await c.query('commit');return {status:'stopped',reason:'case_no_longer_waiting'};}
   if(await suppressed(c,row.recipient_email)){await c.query("update public.crm_case_email_followup_plans set status='stopped',updated_at=now() where id=$1",[row.plan_id]);await c.query("update public.crm_case_email_followup_outbox set status='cancelled',updated_at=now() where plan_id=$1 and status='queued'",[row.plan_id]);await c.query('commit');return {status:'stopped',reason:'suppressed'};}
   if(await activeWhatsappPlan(c,row.conversation_id)){await c.query("update public.crm_case_email_followup_plans set status='paused',updated_at=now() where id=$1",[row.plan_id]);await c.query("update public.crm_case_email_followup_outbox set status='queued',claim_token=null,claimed_at=null,updated_at=now() where id=$1",[row.id]);await c.query('commit');return {status:'paused',reason:'whatsapp_plan_active'};}
   const template=renderSequenceMessage(sequenceSteps(row.language)[row.step],{name:'',contact_name:'',email:row.recipient_email,language:row.language},{language:row.language,unsubscribeUrl:unsubscribeUrlFor(row.recipient_email)});
   if(template.missingExperienceUrl||template.missingUnsubscribeUrl){await c.query("update public.crm_case_email_followup_plans set status='paused',updated_at=now() where id=$1",[row.plan_id]);await c.query("update public.crm_case_email_followup_outbox set status='queued',claim_token=null,claimed_at=null,error_code=$2,updated_at=now() where id=$1",[row.id,template.missingExperienceUrl?'EXPERIENCE_URL_MISSING':'UNSUBSCRIBE_URL_MISSING']);await c.query('commit');return {status:'paused',reason:'template_incomplete'};}
   try{const sent=await sendEmail({to:row.recipient_email,subject:template.subject,body:template.body,planId:row.plan_id,step:row.step,caseType:row.case_type,caseId:row.case_id,conversationId:row.conversation_id,claimToken:row.claim_token});if(!sent?.providerMessageId)throw fail('SEND_UNCONFIRMED','Envío no confirmado',503);
    await c.query("update public.crm_case_email_followup_outbox set status='accepted',provider_message_id=$2,sent_at=now(),updated_at=now(),error_code=null where id=$1",[row.id,sent.providerMessageId]);const accepted=(await c.query("select count(*)::int n from public.crm_case_email_followup_outbox where plan_id=$1 and status='accepted'",[row.plan_id])).rows[0].n;if(accepted>=3)await c.query("update public.crm_case_email_followup_plans set status='human_review',updated_at=now() where id=$1",[row.plan_id]);await c.query('commit');return {status:'accepted',step:row.step,humanReview:accepted>=3};
   }catch(e){const bounce=e?.code==='BOUNCE'||e?.code==='EMAIL_BOUNCE';await c.query("update public.crm_case_email_followup_outbox set status=$2,error_code=$3,updated_at=now() where id=$1",[row.id,bounce?'failed':'failed',String(e?.code||'SEND_FAILED')]);await c.query("update public.crm_case_email_followup_plans set status=$2,updated_at=now() where id=$1",[row.plan_id,bounce?'stopped':'paused']);if(bounce)await c.query("update public.crm_case_email_followup_outbox set status='cancelled',updated_at=now() where plan_id=$1 and status='queued'",[row.plan_id]);await c.query('commit');return {status:bounce?'bounce':'paused',stopped:bounce,reason:e?.code||'SEND_FAILED'};}
  }catch(e){try{await c.query('rollback');}catch{}throw e;}finally{c.release();}
 }
 async function stopOnHumanEvent({planId,reason,bounce=false}={}){if(bounce)return stopPlan({planId,reason:'bounce'});const r=validStop(reason)?reason:null;if(!r)throw fail('EVENT_INVALID','Evento inválido');return stopPlan({planId,reason:r});}
 return {activatePlan,stopPlan,claimDispatch,deliver,stopOnHumanEvent,recoverStale,CASE_EMAIL_STEP_DAYS,classifyProspectReply};
}
