import {normalizeEmail} from './crmContact.js';
const valid=value=>typeof value==='string'&&value.length<=320&&/^[-a-zA-Z0-9.!#$%&'*+/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value);
// Reads only identities of persisted eligible commercial cases. No mailbox rows,
// guessed form fields, routing metadata or caller-supplied addresses grant scope.
export function createCommercialImapSenderReader({pool}={}){
 return async()=>{
  if(!pool?.query)throw new Error('Commercial sender reader unavailable');
  const result=await pool.query(`select p.email_normalized,c.identity_used from public.crm_conversations c
   join public.crm_contacts p on p.id=c.contact_id
   where public.crm_commercial_form_is_allowed(c.id)
   and exists(select 1 from public.crm_inbound_events e where e.conversation_id=c.id and e.source_channel='email' and e.origin=c.origin)
   order by c.id limit 1001`);
  if(!Array.isArray(result.rows)||result.rows.length>1000)throw new Error('Commercial sender scope unavailable');
  const addresses=new Set();
  for(const row of result.rows){
   const canonical=valid(row.email_normalized)?normalizeEmail(row.email_normalized):null;
   if(!canonical)continue;
   addresses.add(canonical);
   // identity_used is server-ingested original contact identity; accept it only
   // if it resolves to the SAME persisted contact (important for Gmail dots/+).
   if(valid(row.identity_used)&&normalizeEmail(row.identity_used)===canonical)addresses.add(row.identity_used.toLowerCase());
  }
  if(addresses.size>1000)throw new Error('Commercial sender scope unavailable');
  return [...addresses];
 };
}
