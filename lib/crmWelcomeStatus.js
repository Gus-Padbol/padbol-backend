import {isCommercialFormConversation} from './crmCommercialScope.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const eligibleWelcomeStatusRow=row=>Boolean(row?.source_channel==='email' && UUID.test(row.id || '') && UUID.test(row.contact_id || row.contact?.id || '') && !row.test_hidden_at && !row.email_return_linked_to && isCommercialFormConversation(row));
export const unavailableWelcomeStatus=()=>({status:'unavailable',sent_at:null,response_state:'no_reply_registered',response_at:null});
const iso=value=>{const date=value == null ? null : new Date(value);return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;};

// Private CRM projection only. The caller first applies its existing reader and
// conversation scope. Scope is bounded and rechecked against id/contact/origin
// in this one aggregate read; no other same-contact conversation is inspected.
// A form initial event shares its conversation source_ref, even if a client
// chooses a misleading email-message prefix. It is never a received reply.
export function createCrmWelcomeStatusReader({pool}={}) {
  return async rows=>{
    const eligible=rows.filter(eligibleWelcomeStatusRow).slice(0,200);
    const result=new Map(eligible.map(row=>[row.id,unavailableWelcomeStatus()]));
    if(!eligible.length || !pool?.query)return result;
    const scope=eligible.map(row=>({id:row.id,contact_id:row.contact_id || row.contact.id,origin:row.origin}));
    try {
      const read=await pool.query(`select c.id,l.status,l.accepted_at,
        case when l.status='accepted' then (
          select max(e.received_at) from public.crm_inbound_events e
           where e.conversation_id=c.id and e.source_channel='email'
             and e.received_at>l.accepted_at
             and (e.origin='institutional_email' or (e.source_ref ~ '^email-message:[0-9a-f]{64}$' and e.source_ref<>c.source_ref))
        ) end as response_at
        from jsonb_to_recordset($1::jsonb) as allowed(id uuid,contact_id uuid,origin text)
        join public.crm_conversations c on c.id=allowed.id and c.contact_id=allowed.contact_id and c.origin=allowed.origin
        left join public.crm_welcome_ledger l on l.contact_id=c.contact_id and l.purpose='welcome'
        where c.source_channel='email' and c.test_hidden_at is null and c.email_return_linked_to is null`,[JSON.stringify(scope)]);
      for(const row of read.rows || []) {
        if(!result.has(row.id))continue;
        const sentAt=iso(row.accepted_at);
        const status=row.status == null ? 'not_recorded' : row.status==='claimed' ? 'processing' : row.status==='accepted' && sentAt ? 'sent' : 'needs_review';
        const responseAt=status==='sent' ? iso(row.response_at) : null;
        result.set(row.id,{status,sent_at:status==='sent' ? sentAt : null,response_state:responseAt ? 'reply_received' : 'no_reply_registered',response_at:responseAt});
      }
    } catch { /* Keep the inbox available; unavailable never means sent/pending. */ }
    return result;
  };
}
