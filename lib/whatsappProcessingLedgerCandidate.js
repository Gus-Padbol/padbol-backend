// Claim only work that the new ingress received before CRM storage. A legacy
// CRM event without a claim belongs to the old service and is not reinterpreted.
export function createWhatsappProcessingLedgerCandidate(pool) {
  if(!pool?.query) throw Error('WA_LEDGER_CONFIG_INVALID');
  return {
    async begin(id) {
      await pool.query(`insert into crm_whatsapp_processing_decisions(inbound_message_id)
        select m.id from whatsapp_inbound_messages m join whatsapp_tenant_channels c on c.id=m.channel_id and c.tenant_id=m.tenant_id
        where m.id=$1 and c.meta_phone_number_id='1376102838911694' and c.meta_waba_id='928900479733370'
          and not exists(select 1 from crm_inbound_events e where e.source_channel='whatsapp' and e.origin='whatsapp:'||c.meta_phone_number_id and e.source_ref=m.provider_message_id)
        on conflict do nothing`,[id]);
      const result=await pool.query('select status from crm_whatsapp_processing_decisions where inbound_message_id=$1',[id]);
      return result.rows[0]?.status==='pending';
    },
    async complete(id) { await pool.query("update crm_whatsapp_processing_decisions set status='done',updated_at=now() where inbound_message_id=$1 and status='pending'",[id]); }
  };
}
