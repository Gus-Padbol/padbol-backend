import {markVerifiedCommercialEmail} from './crmCommercialEmailTriage.js';

// The private RPC filters the effective state before its bounded result window.
// Missing rollout/migration fails closed instead of silently returning a partial page.
export async function listInboxEffectiveState(db, filters, {commercialOnly=false,emailTriageEnabled=false}={}) {
  if(typeof db?.rpc!=='function') throw Object.assign(new Error('No se pudo leer el estado comercial de las consultas.'),{status:503,code:'CRM_INBOX_STATE_UNAVAILABLE'});
  const {data,error}=await db.rpc('crm_inbox_effective_state_list',{
    p_state:filters.estado,p_commercial_only:commercialOnly,p_hidden_only:filters.hiddenOnly===true,
    p_source_channel:filters.sourceChannel || null,p_origins:filters.origins || null,
    p_conversation_id:filters.conversationId || null,p_ticket_number:filters.ticketNumber ? String(filters.ticketNumber) : null,
    p_email_triage_enabled:emailTriageEnabled,
  });
  if(error || !Array.isArray(data)) throw Object.assign(new Error('No se pudo leer el estado comercial de las consultas.'),{status:503,code:'CRM_INBOX_STATE_UNAVAILABLE'});
  return data.map(item=>{
    const {commercial_email_triage_verified,...row}=item;
    return emailTriageEnabled && commercial_email_triage_verified===true
      ? markVerifiedCommercialEmail(row,{conversation_id:row.id}) : row;
  });
}
