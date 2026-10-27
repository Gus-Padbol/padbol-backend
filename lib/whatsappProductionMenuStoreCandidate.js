// The atomic menu store is deliberately inert: callers must explicitly wire it
// into the webhook and gate transport separately after production validation.
export function createWhatsappMenuAtomicStore(supabaseAdmin) {
  if (!supabaseAdmin?.from || !supabaseAdmin?.rpc) throw new Error('WHATSAPP_MENU_STORE_UNAVAILABLE');
  return {
    async findByInbound(inboundId) {
      const { data, error } = await supabaseAdmin.from('crm_whatsapp_menu_events')
        .select('inbound_message_id,conversation_id,reply_id,outbox_id,menu_revision')
        .eq('inbound_message_id', inboundId).maybeSingle();
      if (error) throw new Error('WHATSAPP_MENU_EVENT_UNAVAILABLE');
      return data || null;
    },
    async findByOutbox(outboxId) {
      const { data, error } = await supabaseAdmin.from('crm_whatsapp_menu_events')
        .select('inbound_message_id,conversation_id,reply_id,outbox_id,menu_revision')
        .eq('outbox_id', outboxId).maybeSingle();
      if (error) throw new Error('WHATSAPP_MENU_EVENT_UNAVAILABLE');
      return data || null;
    },
    async commit({ inboundId, conversationId, expectedVersion, state, response, idempotencyKey }) {
      const { data, error } = await supabaseAdmin.rpc('crm_commit_whatsapp_menu_transition', {
        p_inbound_id: inboundId, p_conversation_id: conversationId,
        p_expected_version: expectedVersion, p_state: state,
        p_response: response || null, p_idempotency_key: idempotencyKey || null,
      });
      if (error || !data || typeof data.created !== 'boolean') throw new Error('WHATSAPP_MENU_COMMIT_FAILED');
      return data;
    },
    async confirmSent({ outboxId, tenantId, providerMessageId, sentAt }) {
      const { error } = await supabaseAdmin.rpc('crm_confirm_whatsapp_menu_sent', {
        p_outbox_id: outboxId, p_tenant_id: tenantId,
        p_provider_message_id: providerMessageId, p_sent_at: sentAt,
      });
      if (error) throw new Error('WHATSAPP_MENU_CONFIRM_FAILED');
    },
  };
}
