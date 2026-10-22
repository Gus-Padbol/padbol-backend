// Production-only recovery of already persisted text messages; no raw webhook replay.
// It is deliberately disabled unless a concrete rollout cutoff is configured.
export function createWhatsappProductionRecoveryCandidate({pool,ingress,channelId,cutoff,now=()=>new Date(),logger=console}={}) {
  if (!pool?.query || typeof ingress!=='function' || !/^[0-9a-f-]{36}$/i.test(channelId||'')) throw Error('WA_RECOVERY_CONFIG_INVALID');
  const start=new Date(cutoff);
  if (!cutoff || !Number.isFinite(start.getTime()) || start.getTime()>now().getTime()) throw Error('WA_RECOVERY_CUTOFF_INVALID');
  let cursor=null;
  return {async run(limit=20) {
    const bounded=Math.max(1,Math.min(20,Number(limit)||20));
    // A minute grace allows the original request to finish. Media placeholders
    // and ambiguous legacy audio are omitted: operator review is required.
    const {rows}=await pool.query(`select m.*,m.created_at::text as created_at_cursor,c.meta_phone_number_id,c.meta_waba_id,c.active,c.credential_ref from whatsapp_inbound_messages m
      join whatsapp_tenant_channels c on c.id=m.channel_id and c.tenant_id=m.tenant_id
      left join crm_whatsapp_processing_decisions d on d.inbound_message_id=m.id
      where m.channel_id=$1 and c.active=true and c.meta_phone_number_id='1376102838911694' and c.meta_waba_id='928900479733370'
      and m.created_at >= $2 and m.created_at < now()-interval '1 minute' and m.message_type='text'
      and m.meta_media_type is null and m.text_body not like '[WhatsApp:%'
      and (d.status='pending' or (d.inbound_message_id is null and not exists(select 1 from crm_inbound_events e where e.source_channel='whatsapp'
        and e.source_ref=m.provider_message_id and e.origin='whatsapp:'||c.meta_phone_number_id)))
      and ($4::timestamptz is null or (m.created_at,m.id)>($4::timestamptz,$5::uuid))
      order by m.created_at,m.id limit $3`,[channelId,start.toISOString(),bounded,cursor?.createdAt||null,cursor?.id||null]);
    if (!rows.length) cursor=null;
    else cursor={createdAt:rows.at(-1).created_at_cursor,id:rows.at(-1).id};
    let completed=0,failed=0;
    for(const row of rows) {
      try {
        await ingress({channel:{id:row.channel_id,tenant_id:row.tenant_id,meta_phone_number_id:row.meta_phone_number_id,meta_waba_id:row.meta_waba_id,credential_ref:row.credential_ref,active:row.active},
          inbound:{phoneNumberId:row.meta_phone_number_id,providerMessageId:row.provider_message_id,fromWaId:row.from_wa_id,messageType:'text',textBody:row.text_body,receivedAt:new Date(row.received_at).toISOString()},inboundRow:row});
        completed++;
      } catch(error) {failed++;logger?.warn?.('[whatsapp-recovery] message needs review',{code:error?.code||'WHATSAPP_RECOVERY_UNAVAILABLE'});}
    }
    return {examined:rows.length,completed,failed};
  }};
}
