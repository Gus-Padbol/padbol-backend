import {randomUUID} from 'node:crypto';
import {sequenceSteps, renderSequenceMessage, classifyProspectReply} from './crmProspectSequence.js';

export const CASE_EMAIL_STEP_DAYS = Object.freeze([0,7,14]);
const fail=(code,message,status=400)=>Object.assign(new Error(message||code),{code,status});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function absoluteDue(startedAt,step){return new Date(new Date(startedAt).getTime()+CASE_EMAIL_STEP_DAYS[step]*86400000);}
function stopReason(reason){return ['reply','meeting','closed','optout','bounce','manual'].includes(String(reason||''))?String(reason):null;}

export function createCaseEmailFollowup({pool,sendEmail,now=()=>new Date(),logger=console}={}){
 if(!pool?.query)throw fail('POOL_REQUIRED','Falta pool');
 if(typeof sendEmail!=='function')throw fail('SENDER_REQUIRED','Falta sender');
 async function activatePlan({caseType,caseId,conversationId,recipientEmail,language='es',consentEvidence,startedAt=new Date(),createdBy,explicitHuman=false}={}){
  if(!['form','whatsapp'].includes(caseType)||!uuid.test(String(caseId||''))||!uuid.test(String(conversationId||'')))throw fail('INVALID_CASE','Caso inválido');
  if(explicitHuman!==true)throw fail('EXPLICIT_HUMAN_REQUIRED','La activación requiere transición humana explícita');
  if(!email.test(String(recipientEmail||'')))throw fail('EMAIL_REQUIRED','Correo verificado requerido');
  if(!['es','en'].includes(language))throw fail('LANGUAGE_REQUIRED','Idioma inválido');
  if(typeof consentEvidence!=='string'||!consentEvidence.trim()||consentEvidence.length>2000)throw fail('CONSENT_REQUIRED','Evidencia de permiso requerida');
  const at=new Date(startedAt);if(!Number.isFinite(at.getTime()))throw fail('START_REQUIRED','Inicio inválido');
  const c=await pool.connect();let tx=false;
  try{await c.query('begin');tx=true;
   const existing=(await c.query("select id,status from public.crm_case_email_followup_plans where case_type=$1 and case_id=$2 and status in ('active','paused','human_review') for update",[caseType,caseId])).rows[0];
   if(existing)return {status:existing.status,planId:existing.id,repeated:true,nextAt:null};
   const plan=(await c.query(`insert into public.crm_case_email_followup_plans(case_type,case_id,conversation_id,recipient_email,language,status,started_at,consent_evidence,created_by) values($1,$2,$3,$4,$5,'active',$6,$7,$8) returning *`,[caseType,caseId,conversationId,recipientEmail,language,at.toISOString(),consentEvidence.trim(),createdBy||null])).rows[0];
   for(let step=0;step<3;step++)await c.query("insert into public.crm_case_email_followup_outbox(plan_id,step,due_at) values($1,$2,$3) on conflict(plan_id,step) do nothing",[plan.id,step,absoluteDue(at,step).toISOString()]);
   await c.query('commit');tx=false;return {status:'active',planId:plan.id,repeated:false,nextAt:absoluteDue(at,0).toISOString()};
  }catch(e){if(tx)try{await c.query('rollback');}catch{}throw e;}finally{c.release();}
 }
 async function stopPlan({planId,reason='manual'}={}){
  if(!uuid.test(String(planId||''))||!stopReason(reason))throw fail('STOP_INVALID','Plan/motivo inválido');
  const c=await pool.connect();try{await c.query('begin');const p=(await c.query('select id from public.crm_case_email_followup_plans where id=$1 for update',[planId])).rows[0];if(!p)throw fail('PLAN_NOT_FOUND','Plan no encontrado',404);await c.query("update public.crm_case_email_followup_plans set status=$2,updated_at=now() where id=$1",[planId,reason==='bounce'?'stopped':'stopped']);await c.query("update public.crm_case_email_followup_outbox set status='cancelled',updated_at=now() where plan_id=$1 and status='queued'",[planId]);await c.query('commit');return {status:'stopped',reason};}catch(e){try{await c.query('rollback');}catch{}throw e;}finally{c.release();}
 }
 async function claimDispatch({limit=10}={}){
  const client=await pool.connect();const claimed=[];try{await client.query('begin');
   const rows=(await client.query(`select o.id,o.plan_id,o.step,o.due_at,p.case_type,p.case_id,p.conversation_id,p.recipient_email,p.language from public.crm_case_email_followup_outbox o join public.crm_case_email_followup_plans p on p.id=o.plan_id where o.status='queued' and o.due_at<=$1 and p.status='active' order by o.due_at,o.id for update of o skip locked limit $2`,[now().toISOString(),Math.max(1,Math.min(50,Number(limit)||10))])).rows;
   for(const row of rows){const token=randomUUID();const up=await client.query("update public.crm_case_email_followup_outbox set status='claimed',claim_token=$2,claimed_at=now(),attempts=attempts+1,updated_at=now() where id=$1 and status='queued' returning *",[row.id,token]);if(up.rowCount)claimed.push({...row,claimToken:token});}
   await client.query('commit');return claimed;
  }catch(e){try{await client.query('rollback');}catch{}throw e;}finally{client.release();}
 }
 async function deliver({dispatch}={}){
  if(!dispatch?.claimToken)throw fail('CLAIM_REQUIRED','Claim requerido');
  const c=await pool.connect();try{await c.query('begin');
   const row=(await c.query(`select o.*,p.recipient_email,p.language,p.case_type,p.case_id,p.conversation_id,p.status plan_status from public.crm_case_email_followup_outbox o join public.crm_case_email_followup_plans p on p.id=o.plan_id where o.id=$1 and o.claim_token=$2 and o.status='claimed' and p.status='active' for update`,[dispatch.id,dispatch.claimToken])).rows[0];
   if(!row){await c.query('rollback');return {status:'cancelled'};}
   const template=renderSequenceMessage(sequenceSteps(row.language)[row.step],{name:'',contact_name:'',email:row.recipient_email,language:row.language},{language:row.language,unsubscribeUrl:''});
   try{const sent=await sendEmail({to:row.recipient_email,subject:template.subject,body:template.body,planId:row.plan_id,step:row.step,caseType:row.case_type,caseId:row.case_id,conversationId:row.conversation_id,claimToken:row.claim_token});if(!sent?.providerMessageId)throw fail('SEND_UNCONFIRMED','Envío no confirmado',503);
    await c.query("update public.crm_case_email_followup_outbox set status='accepted',provider_message_id=$2,sent_at=now(),updated_at=now(),error_code=null where id=$1",[row.id,sent.providerMessageId]);
    const accepted=(await c.query("select count(*)::int n from public.crm_case_email_followup_outbox where plan_id=$1 and status='accepted'",[row.plan_id])).rows[0].n;
    if(accepted>=3)await c.query("update public.crm_case_email_followup_plans set status='human_review',updated_at=now() where id=$1",[row.plan_id]);
    await c.query('commit');return {status:'accepted',step:row.step,humanReview:accepted>=3};
   }catch(e){const bounce=e?.code==='BOUNCE'||e?.code==='EMAIL_BOUNCE';if(bounce){await c.query("update public.crm_case_email_followup_outbox set status='failed',error_code='BOUNCE',updated_at=now() where id=$1",[row.id]);await c.query("update public.crm_case_email_followup_plans set status='stopped',updated_at=now() where id=$1",[row.plan_id]);await c.query("update public.crm_case_email_followup_outbox set status='cancelled',updated_at=now() where plan_id=$1 and status='queued'",[row.plan_id]);await c.query('commit');return {status:'bounce',stopped:true};}await c.query("update public.crm_case_email_followup_outbox set status='failed',error_code=$2,updated_at=now() where id=$1",[row.id,String(e?.code||'SEND_FAILED')]);await c.query('commit');throw e;}
  }catch(e){try{await c.query('rollback');}catch{}throw e;}finally{c.release();}
 }
 async function stopOnHumanEvent({planId,reason,bounce=false}={}){if(bounce)return stopPlan({planId,reason:'bounce'});const r=stopReason(reason);if(!r)throw fail('EVENT_INVALID','Evento inválido');return stopPlan({planId,reason:r});}
 return {activatePlan,stopPlan,claimDispatch,deliver,stopOnHumanEvent,classifyProspectReply,CASE_EMAIL_STEP_DAYS};
}
