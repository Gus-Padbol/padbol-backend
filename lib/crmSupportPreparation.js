// Contrato interno; no monta rutas, no crea identidades/tickets y no importa senders.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(code,status=503)=>Object.assign(new Error(code),{code,status});
export function createCrmSupportPreparation({repository,authorize,resolveVerifiedTicket}={}) {
 if(!repository?.prepareEvent||typeof authorize!=='function')throw fail('SUPPORT_PREPARATION_NOT_CONFIGURED');
 return {async prepare({conversationId,eventId,context}={}) {
  const actor=await authorize(context);
  if(!actor?.canPrepare||!UUID.test(actor.userId||''))throw fail('SUPPORT_PREPARATION_FORBIDDEN',403);
  if(!UUID.test(conversationId||'')||!UUID.test(eventId||''))throw fail('SUPPORT_PREPARATION_INVALID',400);
  // El resolver es dependencia del backend. Nunca se toma requester/sede de texto o input cliente.
  const ticket=typeof resolveVerifiedTicket==='function'?await resolveVerifiedTicket({conversationId,context}):null;
  if(ticket&&(!ticket.verified||!Number.isSafeInteger(ticket.id)||ticket.id<1||!UUID.test(ticket.requesterUserId||'')||(ticket.sedeId!=null&&(!Number.isSafeInteger(ticket.sedeId)||ticket.sedeId<1))))throw fail('SUPPORT_TICKET_IDENTITY_UNVERIFIED',409);
  const result=await repository.prepareEvent({conversationId,eventId,actorId:actor.userId,ticket});
  if(!result||result.conversationId!==conversationId||result.eventId!==eventId||result.mode!=='preparation'||result.sendEnabled!==false||!['identity_required','prepared'].includes(result.preparationState))throw fail('SUPPORT_PREPARATION_UNCONFIRMED');
  return result;
 }};
}
export function createSupabaseSupportPreparationRepository(client){
 if(typeof client?.rpc!=='function')throw fail('SUPPORT_PREPARATION_NOT_CONFIGURED');
 return {async prepareEvent({conversationId,eventId,actorId,ticket}){
  const {data,error}=await client.rpc('crm_prepare_support_event',{p_conversation_id:conversationId,p_event_id:eventId,p_actor_id:actorId,p_ticket_id:ticket?.id??null,p_requester_user_id:ticket?.requesterUserId??null,p_sede_id:ticket?.sedeId??null});
  if(error)throw fail('SUPPORT_PREPARATION_PERSIST_FAILED');
  return data;
 },async loadCase(caseId){
  const {data,error}=await client.from('crm_support_cases').select('*').eq('id',caseId).maybeSingle();
  if(error)throw fail('SUPPORT_CASE_LOAD_FAILED');return data;
 },async getLifecycleAction(caseId,actionKey){
  const {data,error}=await client.from('crm_support_lifecycle_actions').select('command_hash,result').eq('case_id',caseId).eq('action_key',actionKey).maybeSingle();
  if(error)throw fail('SUPPORT_ACTION_LOAD_FAILED');return data;
 },async applyLifecycle({caseId,actionKey,commandHash,expectedVersion,actorId,action,nextState,payload,effects}){
  const {data,error}=await client.rpc('crm_support_apply_lifecycle',{p_case_id:caseId,p_action_key:actionKey,p_command_hash:commandHash,p_expected_version:expectedVersion,p_actor_id:actorId,p_action:action,p_next_state:nextState,p_payload:payload,p_effects:effects});
  if(error)throw fail('SUPPORT_LIFECYCLE_PERSIST_FAILED');return data;
 },async reconcilePending(limit=100){
  const {data,error}=await client.rpc('crm_reconcile_support_preparation',{p_limit:limit});
  if(error)throw fail('SUPPORT_RECONCILIATION_FAILED');return data;
 }};
}
