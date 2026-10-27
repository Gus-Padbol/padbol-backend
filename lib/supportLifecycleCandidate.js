// Lifecycle interno candidato. No HTTP, cron, modelo, sender ni ejecución remota.
import {createHash} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const text=(value,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw fail('SUPPORT_LIFECYCLE_INVALID',400);return value.trim();};
const reference=value=>text(value,180);
function evidence(value){if(!Array.isArray(value)||!value.length||value.length>12)throw fail('SUPPORT_EVIDENCE_REQUIRED');return value.map(x=>({kind:reference(x?.kind),reference:reference(x?.reference)}));}
function proposal(value){if(!value||typeof value!=='object')throw fail('SUPPORT_PROPOSAL_REQUIRED');return {summary:text(value.summary),reply:text(value.reply),evidence:evidence(value.evidence),verification:{status:['passed','failed','not_run'].includes(value.verification?.status)?value.verification.status:'not_run',evidence:evidence(value.verification?.evidence)}};}
export function createSupportLifecycle({repository,authorize,verifyEvidence,resolveExistingAcknowledgement}={}){
 if(!repository?.loadCase||!repository?.getLifecycleAction||!repository?.applyLifecycle||typeof authorize!=='function'||typeof verifyEvidence!=='function'||typeof resolveExistingAcknowledgement!=='function')throw fail('SUPPORT_LIFECYCLE_NOT_CONFIGURED',503);
 async function command({caseId,requestId,context,action,capability,input,prepare}){
  if(!Number.isSafeInteger(caseId)||caseId<1||!UUID.test(requestId||''))throw fail('SUPPORT_LIFECYCLE_INVALID',400);
  const record=await repository.loadCase(caseId);
  if(!record||record.id!==caseId||!/^PB-[1-9][0-9]{5,11}$/.test(record.public_reference||'')||!UUID.test(record.conversation_id||'')||!['email','whatsapp'].includes(record.source_channel))throw fail('SUPPORT_CASE_NOT_DURABLE');
  const actor=await authorize(context,{capability,caseRecord:record});
  if(actor?.allowed!==true||!UUID.test(actor.userId||'')||actor.conversationId!==record.conversation_id)throw fail('SUPPORT_LIFECYCLE_FORBIDDEN',403);
  const key=action+':'+requestId.toLowerCase(),hash=createHash('sha256').update(stable({action,input})).digest('hex');
  const old=await repository.getLifecycleAction(caseId,key);
  if(old){if(old.command_hash!==hash)throw fail('SUPPORT_ACTION_KEY_CONFLICT');return {case:record,duplicate:true,effects:[]};}
  const next=await prepare(record,actor);
  const result=await repository.applyLifecycle({caseId,actionKey:key,commandHash:hash,expectedVersion:record.version,actorId:actor.userId,action,nextState:next.state,payload:next.payload||{},effects:next.effects||[]});
  if(!result?.case||result.case.id!==caseId||result.case.conversation_id!==record.conversation_id||result.case.source_channel!==record.source_channel)throw fail('SUPPORT_LIFECYCLE_UNCONFIRMED',503);
  return result;
 }
 const effect=(record,type,key,payload)=>({type,key,payload:{...payload,conversation_id:record.conversation_id,channel:record.source_channel,case_reference:record.public_reference,send_enabled:false}});
 return {
  prepare({caseId,eventId,context}={}){
   if(!UUID.test(eventId||''))throw fail('SUPPORT_LIFECYCLE_INVALID',400);
   return command({caseId,requestId:eventId,context,action:'prepare',capability:'support.prepare',input:{eventId},prepare:async record=>{
    if(record.lifecycle_state!=='received')throw fail('SUPPORT_TRANSITION_INVALID');
    const effects=[effect(record,'technical_delegation','technical:'+eventId,{event_id:eventId,instructions:'Revisar el caso y preparar una propuesta con evidencia. Esta tarea no inicia un agente permanente ni autoriza cambios o envíos.'})];
    let acknowledgement,deliveryReviewRequired=false;
    if(record.source_channel==='whatsapp'){
     if(record.acknowledgement_policy!=='reuse_existing_menu_only')throw fail('SUPPORT_ACK_POLICY_INVALID');
     const existing=await resolveExistingAcknowledgement({caseRecord:record,eventId});
     const verified=existing?.verified===true&&existing.eventId===eventId&&existing.reference===record.public_reference&&typeof existing.outboxId==='string'&&['pending','sending','sent','uncertain'].includes(existing.status);
     acknowledgement=verified?{policy:'reuse_existing_menu_only',reference:existing.reference,status:existing.status,outboxId:existing.outboxId}:{policy:'reuse_existing_menu_only',status:'not_verified'};
     deliveryReviewRequired=!verified||['sending','uncertain'].includes(existing?.status);
    }else{
     if(record.acknowledgement_policy!=='prepare_only')throw fail('SUPPORT_ACK_POLICY_INVALID');
     acknowledgement={policy:'prepare_only',status:'draft_only'};
     effects.push(effect(record,'acknowledgement_draft','ack:'+eventId,{body:`Recibimos tu consulta. Tu caso de soporte es el N.º ${record.public_reference}. Vamos a revisarlo y te responderemos por este mismo medio.`}));
    }
    return {state:'technical_pending',payload:{source_event_id:eventId,acknowledgement,delivery_review_required:deliveryReviewRequired,resolved:false},effects};
   }});
  },
  startTechnicalReview({caseId,requestId,context}={}){return command({caseId,requestId,context,action:'technical_start',capability:'support.technical',input:{},prepare:async(record,actor)=>{
   if(record.lifecycle_state!=='technical_pending')throw fail('SUPPORT_TRANSITION_INVALID');
   return {state:'technical_review',payload:{technical_actor_id:actor.userId}};
  }});},
  proposeResolution({caseId,requestId,context,proposal:inputProposal}={}){
   const normalized=proposal(inputProposal);
   return command({caseId,requestId,context,action:'technical_proposal',capability:'support.technical',input:normalized,prepare:async(record,actor)=>{
    if(record.lifecycle_state!=='technical_review'||record.lifecycle_data?.technical_actor_id!==actor.userId)throw fail('SUPPORT_TRANSITION_INVALID');
    return {state:'coordination_review',payload:{proposal:normalized,proposal_request_id:requestId,proposal_actor_id:actor.userId,resolved:false}};
   }});
  },
  reviewDelivery({caseId,requestId,context,outcome,evidence:proof}={}){
   const normalized={outcome,evidence:evidence(proof)};
   if(!['sent','not_sent'].includes(outcome))throw fail('SUPPORT_DELIVERY_REVIEW_REQUIRED');
   return command({caseId,requestId,context,action:'delivery_review',capability:'support.coordination',input:normalized,prepare:async record=>{
    if(record.lifecycle_data?.delivery_review_required!==true||record.lifecycle_state==='response_draft_ready')throw fail('SUPPORT_TRANSITION_INVALID');
    if(await verifyEvidence({kind:'delivery_review',caseRecord:record,evidence:normalized.evidence,outcome})!==true)throw fail('SUPPORT_EVIDENCE_UNVERIFIED');
    return {state:record.lifecycle_state,payload:{delivery_review_required:false,delivery_review:normalized,delivery_evidence_verified:true}};
   }});
  },
  approveResponseDraft({caseId,requestId,context}={}){return command({caseId,requestId,context,action:'coordination_approve',capability:'support.coordination',input:{},prepare:async(record,actor)=>{
   if(record.lifecycle_state!=='coordination_review')throw fail('SUPPORT_TRANSITION_INVALID');
   if(record.lifecycle_data?.proposal_actor_id===actor.userId)throw fail('SUPPORT_INDEPENDENT_REVIEW_REQUIRED');
   if(record.lifecycle_data?.delivery_review_required===true)throw fail('SUPPORT_DELIVERY_REVIEW_REQUIRED');
   const p=proposal(record.lifecycle_data?.proposal);
   if(p.verification.status!=='passed'||await verifyEvidence({kind:'resolution',caseRecord:record,proposal:p})!==true)throw fail('SUPPORT_EVIDENCE_UNVERIFIED');
   return {state:'response_draft_ready',payload:{evidence_verified:true,coordination_actor_id:actor.userId,approved_proposal_request_id:record.lifecycle_data.proposal_request_id,resolved:false},effects:[effect(record,'response_draft','response:'+record.lifecycle_data.proposal_request_id,{body:p.reply,evidence:p.evidence,verification:p.verification,delivery_state:'not_sent',requires_authorized_sender:true})]};
  }});},
  rejectProposal({caseId,requestId,context,reason}={}){
   const normalized={reason:text(reason)};
   return command({caseId,requestId,context,action:'coordination_reject',capability:'support.coordination',input:normalized,prepare:async record=>{
    if(record.lifecycle_state!=='coordination_review')throw fail('SUPPORT_TRANSITION_INVALID');
    return {state:'technical_pending',payload:{review_rejection:normalized,resolved:false},effects:[effect(record,'technical_delegation','technical-review:'+requestId,{instructions:normalized.reason})]};
   }});
  },
 };
}
