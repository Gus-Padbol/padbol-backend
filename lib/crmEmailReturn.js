import { Webhook } from 'svix';
import { createHash } from 'node:crypto';

export const CRM_EMAIL_PROVIDER_PATH = '/api/crm/email/provider-events';
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
export function canonicalMessageId(value) {
  const id = String(value || '').trim().replace(/^<([^<>]+)>$/, '$1');
  return id.length <= 500 && /^[^\s<>@]+@[^\s<>@]+$/.test(id) ? id : null;
}
const mailbox = value => /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value || '') ? value.toLowerCase() : null;
const events = new Set(['email.sent', 'email.delivered', 'email.bounced', 'email.failed', 'email.complained']);

// No correlation by sender or subject: require a provider-authenticated RFC ID
// belonging to a recorded outbound reply AND the same contact identity.
export function createCrmEmailReturn({ pool, env = process.env } = {}) {
  const recipient = mailbox(env.CRM_OUTBOUND_EMAIL_REPLY_TO);
  const enabled = env.CRM_EMAIL_RETURN_ENABLED === 'true' && Boolean(pool && recipient);
  const secret = env.CRM_EMAIL_PROVIDER_WEBHOOK_SECRET;
  async function transaction(fn) {
    const c = await pool.connect();
    try { await c.query('begin'); const result = await fn(c); await c.query('commit'); return result; }
    catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }
  return {
    enabled,
    webhookEnabled: enabled && Boolean(secret),
    async providerEvent(raw, headers) {
      if (!enabled || !secret) throw fail('CRM_EMAIL_RETURN_NOT_CONFIGURED', 503);
      if (!Buffer.isBuffer(raw) || raw.length > 100000) throw fail('CRM_EMAIL_PROVIDER_INVALID');
      let event;
      try { new Webhook(secret).verify(raw.toString('utf8'), headers); event = JSON.parse(raw.toString('utf8')); }
      catch { throw fail('CRM_EMAIL_PROVIDER_SIGNATURE_INVALID', 401); }
      if (!events.has(event?.type)) return { ignored: true };
      const providerId = event?.data?.email_id;
      const messageId = canonicalMessageId(event?.data?.message_id);
      const at = new Date(event?.created_at);
      if (typeof providerId !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(providerId)
          || !messageId || !Number.isFinite(at.getTime())) throw fail('CRM_EMAIL_PROVIDER_INVALID');
      return transaction(async c => {
        const r = (await c.query(`select r.id from crm_replies r join crm_conversations c on c.id=r.conversation_id
          where r.provider_message_id=$1 and c.source_channel='email'`, [providerId])).rows;
        if (r.length !== 1) {
          const tags = event.data.tags;
          const tag = Array.isArray(tags) ? tags.find(t=>t?.name==='crm_reply_id')?.value : tags?.crm_reply_id;
          if (typeof tag==='string' && /^[0-9a-f-]{36}$/i.test(tag)) {
            const pending=(await c.query('select provider_message_id from crm_replies where id=$1', [tag])).rows[0];
            // A known CRM send can race its provider acknowledgement. Retry
            // later; never assign a provider ID from a tag alone.
            if (pending && !pending.provider_message_id) throw fail('CRM_EMAIL_PROVIDER_REPLY_NOT_READY',503);
          }
          return {ignored:true};
        }
        const existing = (await c.query('select rfc_message_id from crm_email_provider_receipts where reply_id=$1 for update', [r[0].id])).rows[0];
        if (existing && existing.rfc_message_id !== messageId) throw fail('CRM_EMAIL_PROVIDER_ID_CONFLICT', 409);
        await c.query(`insert into crm_email_provider_receipts(reply_id,provider_message_id,rfc_message_id)
          values($1,$2,$3) on conflict(reply_id) do nothing`, [r[0].id, providerId, messageId]);
        const col = { 'email.sent':'sent_at', 'email.delivered':'delivered_at', 'email.bounced':'bounced_at',
          'email.failed':'failed_at', 'email.complained':'complained_at' }[event.type];
        await c.query(`update crm_email_provider_receipts set ${col}=case when ${col} is null then $2 else least(${col},$2) end where reply_id=$1`, [r[0].id,at.toISOString()]);
        return { recorded: true };
      });
    },
    async ingestReply(event) {
      if (!enabled || mailbox(event?.to) !== recipient || !mailbox(event?.from)) return { matched: false };
      const refs = [...new Set([event.inReplyTo, ...(Array.isArray(event.references) ? event.references : [])].map(canonicalMessageId).filter(Boolean))].slice(-30);
      if (!refs.length) return { matched: false };
      const externalId = canonicalMessageId(event.externalId);
      const sourceRef = externalId ? 'email-message:'+createHash('sha256').update(externalId).digest('hex') : null;
      const at = new Date(event.receivedAt);
      const body = String(event.body || '').trim().slice(0, 4000);
      const subject = String(event.subject || '').trim().slice(0, 512) || null;
      if (!externalId || !body || !Number.isFinite(at.getTime())) return { matched: false };
      return transaction(async c => {
        const rows = (await c.query(`select distinct c.id,c.contact_id,c.origin from crm_email_provider_receipts e
          join crm_replies r on r.id=e.reply_id join crm_conversations c on c.id=r.conversation_id
          join crm_contacts p on p.id=c.contact_id
          where e.rfc_message_id=any($1) and c.source_channel='email' and p.email_normalized=$2
          and c.test_hidden_at is null`, [refs,mailbox(event.from)])).rows;
        if (rows.length !== 1) return { matched: false };
        const row = rows[0];
        const inserted = (await c.query(`insert into crm_inbound_events(conversation_id,source_channel,source_ref,origin,subject,body,received_at)
          values($1,'email',$2,$3,$4,$5,$6) on conflict do nothing returning id`,
        [row.id, sourceRef, row.origin,subject,body,at.toISOString()])).rows[0];
        if (inserted) {
          await c.query(`insert into crm_activities(contact_id,conversation_id,activity_type,summary,author)
            values($1,$2,'note','Respuesta del contacto recibida por correo.','system:email-return')`, [row.contact_id,row.id]);
          // Preserve the original form/message, assignment and commercial state.
          await c.query('update crm_conversations set updated_at=now() where id=$1', [row.id]);
        } else {
          const prior=(await c.query("select conversation_id from crm_inbound_events where source_channel='email' and source_ref=$1",[sourceRef])).rows;
          if (prior.length!==1 || prior[0].conversation_id!==row.id) throw fail('CRM_EMAIL_THREAD_MESSAGE_CONFLICT',409);
        }
        return { matched: true, repeated: !inserted, conversationId: row.id };
      });
    },
  };
}

export function registerCrmEmailProviderRoute(app, { emailReturn, logger = console } = {}) {
  app.post(CRM_EMAIL_PROVIDER_PATH, async (req,res) => {
    if (!emailReturn?.webhookEnabled) return res.status(404).json({ code:'CRM_EMAIL_RETURN_NOT_CONFIGURED' });
    try { return res.json(await emailReturn.providerEvent(req.rawBody,req.headers)); }
    catch(e) { logger?.warn?.('[crm-email-return]', {code:e.code || 'CRM_EMAIL_RETURN_UNAVAILABLE'});
      return res.status(e.status || 503).json({code:e.code || 'CRM_EMAIL_RETURN_UNAVAILABLE'}); }
  });
}
