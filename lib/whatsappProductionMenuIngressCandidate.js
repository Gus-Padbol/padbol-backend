import { createHash } from 'node:crypto';

// Inert until explicitly wired into the signed webhook and a reviewed dispatcher.
export function createProductionMenuIngressCandidate({ menu, dispatcher, phoneNumberId, wabaId } = {}) {
  if (!menu?.ingestWhatsapp || !dispatcher?.dispatch || !phoneNumberId || !wabaId)
    throw Error('WA_PRODUCTION_MENU_INGRESS_INVALID');
  return async ({ channel, inbound, inboundRow } = {}) => {
    if (!channel?.active || channel.meta_phone_number_id !== phoneNumberId || channel.meta_waba_id !== wabaId
        || !inboundRow?.id || !inbound?.providerMessageId || inboundRow.provider_message_id !== inbound.providerMessageId)
      throw Error('WA_PRODUCTION_MENU_CHANNEL_MISMATCH');
    const key = createHash('sha256').update(`${channel.tenant_id}:${channel.id}:${inbound.providerMessageId}:production-menu-v1`).digest('hex');
    const result = await menu.ingestWhatsapp({ ...inbound, menuDelivery: { inboundId: inboundRow.id, idempotencyKey: key } });
    if (result?.outboxId) await dispatcher.dispatch(result.outboxId);
    return { suppressAutomaticReply: true };
  };
}
