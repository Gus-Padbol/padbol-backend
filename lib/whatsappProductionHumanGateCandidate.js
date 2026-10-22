// Experimental only: keep this disabled until the sender, outbox sweep and DB pool
// have been independently verified. Never retry a claimed or uncertain delivery.
const PHONE = '1376102838911694';
const WABA = '928900479733370';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createProductionHumanGateCandidate({ pool, sender, channelId, enabled = false, timeoutMs = 10000, now = Date.now } = {}) {
  if (!enabled) return null;
  if (!pool?.connect || !sender?.sendText || !UUID.test(String(channelId)) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw Error('WA_HUMAN_GATE_CONFIG');
  async function withClient(work) { const client = await pool.connect(); try { return await work(client); } finally { client.release(); } }
  async function flagReview(c, conversationId) {
    await c.query(`update public.crm_conversations set qualification_data=jsonb_set(coalesce(qualification_data,'{}'::jsonb),
      '{whatsapp_order_review}', '{"required":true,"reason":"uncertain_automated_delivery"}'::jsonb, true), updated_at=clock_timestamp() where id=$1`,[conversationId]);
  }
  async function stop(id, code) { return withClient(async c => {
    await c.query('begin');
    try {
      const event=(await c.query('select conversation_id from public.crm_whatsapp_menu_events where outbox_id=$1',[id])).rows[0];
      if (event) await c.query('select id from public.crm_conversations where id=$1 for update',[event.conversation_id]);
      const result=await c.query("update public.whatsapp_outbox set status='cancelled',last_error=$2,updated_at=clock_timestamp() where id=$1 and status='sending' returning id",[id,code]);
      if (result.rowCount && event) await flagReview(c,event.conversation_id);
      await c.query('commit');
    } catch(error) { await c.query('rollback').catch(()=>{}); throw error; }
  }); }
  const gate = { async dispatch(outboxId) {
    if (!UUID.test(String(outboxId))) throw Error('WA_HUMAN_GATE_INVALID');
    // Committed first: a process crash or ambiguous acknowledgement cannot retry.
    const claim = await withClient(async c => (await c.query(`update public.whatsapp_outbox o set status='sending',attempts=attempts+1,last_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
      from public.crm_whatsapp_menu_events e where o.id=$1 and e.outbox_id=o.id and o.status='pending' and o.attempts=0 returning e.conversation_id`,[outboxId])).rows[0]);
    if (!claim) return {status:'held_or_claimed'};
    try { return await withClient(async c => {
      await c.query('begin');
      try {
        const conversation=(await c.query('select * from public.crm_conversations where id=$1 for update',[claim.conversation_id])).rows[0];
        const row=(await c.query(`select e.reply_id,e.menu_revision,e.inbound_message_id,o.id,o.tenant_id,o.channel_id,o.status,o.to_wa_id,o.reply_to_provider_message_id,o.text_body,o.customer_service_window_expires_at,
          i.from_wa_id,i.provider_message_id,i.message_type inbound_type,i.meta_media_type,ch.meta_phone_number_id,ch.meta_waba_id,ch.credential_ref,ch.active,t.status tenant_status,
          (exists(select 1 from public.crm_whatsapp_manual_attempts m where m.conversation_id=e.conversation_id)
            and (not exists(select 1 from public.crm_whatsapp_automation_releases r where r.conversation_id=e.conversation_id)
              or exists(select 1 from public.crm_whatsapp_manual_attempts m join public.crm_replies r on r.id=m.reply_id
                where m.conversation_id=e.conversation_id and r.status<>'sent'))) manual_attempt
          from public.crm_whatsapp_menu_events e join public.whatsapp_outbox o on o.id=e.outbox_id
          join public.whatsapp_inbound_messages i on i.id=e.inbound_message_id and i.id=o.inbound_message_id and i.tenant_id=o.tenant_id and i.channel_id=o.channel_id
          join public.whatsapp_tenant_channels ch on ch.id=o.channel_id and ch.tenant_id=o.tenant_id
          join public.whatsapp_tenants t on t.id=o.tenant_id where o.id=$1 and e.conversation_id=$2 for update of o`,[outboxId,claim.conversation_id])).rows[0];
        const eligible=conversation && row && row.status==='sending' && row.channel_id===channelId && row.meta_phone_number_id===PHONE && row.meta_waba_id===WABA && row.active===true && row.tenant_status==='active'
          && row.inbound_type==='text' && row.meta_media_type==null && row.to_wa_id===row.from_wa_id && row.reply_to_provider_message_id===row.provider_message_id
          && row.reply_id && row.menu_revision!=null && String(row.menu_revision)===String(conversation.test_visibility_version)
          && conversation.source_channel==='whatsapp' && conversation.origin===`whatsapp:${PHONE}` && String(conversation.identity_used || '').replace(/[^0-9]/g,'')===row.from_wa_id
          && conversation.estado==='nuevo' && !conversation.operador && !conversation.sede_id && !conversation.assigned_by && !conversation.derivado
          && (!conversation.handoff_ready || conversation.next_step==='advisor_handoff') && conversation.qualification_data?.whatsapp_order_review?.required!==true && conversation.qualification_data?.whatsapp_message_order_review?.required!==true
          && !row.manual_attempt && new Date(row.customer_service_window_expires_at).getTime()>now();
        if (!eligible) { if (row?.reply_id) await c.query("update public.crm_replies set status='cancelled' where id=$1 and status='pending'",[row.reply_id]); await c.query("update public.whatsapp_outbox set status='cancelled',last_error='WA_HUMAN_GATE_BLOCKED',updated_at=clock_timestamp() where id=$1 and status='sending'",[outboxId]); await c.query('commit'); return {status:'blocked'}; }
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs); let result;
        try { result=await sender.sendText({channel:{id:row.channel_id,meta_phone_number_id:row.meta_phone_number_id,credential_ref:row.credential_ref},toWaId:row.to_wa_id,body:row.text_body,signal:controller.signal}); }
        catch { await c.query("update public.whatsapp_outbox set status='cancelled',last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY',updated_at=clock_timestamp() where id=$1 and status='sending'",[outboxId]); await flagReview(c,claim.conversation_id); await c.query('commit'); return {status:'uncertain'}; }
        finally { clearTimeout(timer); }
        if (typeof result?.providerMessageId!=='string' || !result.providerMessageId.trim() || result.providerMessageId.length>512) { await c.query("update public.whatsapp_outbox set status='cancelled',last_error='WHATSAPP_SEND_UNCERTAIN_NO_RETRY',updated_at=clock_timestamp() where id=$1 and status='sending'",[outboxId]); await flagReview(c,claim.conversation_id); await c.query('commit'); return {status:'uncertain'}; }
        await c.query('select public.crm_confirm_whatsapp_menu_sent($1,$2,$3,clock_timestamp())',[outboxId,row.tenant_id,result.providerMessageId]);
        await c.query('commit'); return {status:'sent'};
      } catch (error) { await c.query('rollback').catch(()=>{}); throw error; }
    }); } catch { await stop(outboxId,'WHATSAPP_SEND_UNCERTAIN_NO_RETRY').catch(()=>{}); return {status:'uncertain'}; }
  },
  async sweep(limit=20) {
    const bounded=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:20));
    const rows=await withClient(async c=>(await c.query(`select o.id from public.whatsapp_outbox o
      join public.crm_whatsapp_menu_events e on e.outbox_id=o.id
      where o.status='pending' and o.attempts=0 and o.channel_id=$1 order by o.id limit $2`,[channelId,bounded])).rows);
    const results=[];for(const row of rows) results.push(await gate.dispatch(row.id));return results;
  }};
  return Object.freeze(gate);
}
