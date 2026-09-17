import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES_LIMIT = 25 * 1024 * 1024;
const DEFAULT_MAX_SYNC_BYTES = 20 * 1024 * 1024;
const MAX_SYNC_BYTES_LIMIT = 50 * 1024 * 1024;

function clean(value, max = 512) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : '';
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function readCrmImapConfig(env = process.env) {
  const enabled = String(env.CRM_INBOUND_IMAP_ENABLED || '').trim().toLowerCase() === 'true';
  const config = {
    enabled,
    host: clean(env.CRM_INBOUND_IMAP_HOST, 255),
    port: positiveInteger(env.CRM_INBOUND_IMAP_PORT, 993, { max: 65535 }),
    secure: String(env.CRM_INBOUND_IMAP_SECURE ?? 'true').trim().toLowerCase() !== 'false',
    user: clean(env.CRM_INBOUND_IMAP_USER, 320).toLowerCase(),
    password: String(env.CRM_INBOUND_IMAP_PASSWORD || ''),
    mailbox: clean(env.CRM_INBOUND_IMAP_MAILBOX, 120) || 'INBOX',
    expectedRecipient: clean(env.CRM_INBOUND_IMAP_EXPECTED_RECIPIENT, 320).toLowerCase() || 'info@padbol.com',
    intervalMs: positiveInteger(env.CRM_INBOUND_IMAP_INTERVAL_MS, DEFAULT_INTERVAL_MS, { min: 60_000, max: 3_600_000 }),
    lookbackDays: positiveInteger(env.CRM_INBOUND_IMAP_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS, { min: 1, max: 30 }),
    maxMessages: positiveInteger(env.CRM_INBOUND_IMAP_MAX_MESSAGES, DEFAULT_MAX_MESSAGES, { min: 1, max: 500 }),
    maxMessageBytes: positiveInteger(env.CRM_INBOUND_IMAP_MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES, {
      min: 1024,
      max: MAX_MESSAGE_BYTES_LIMIT,
    }),
    maxSyncBytes: positiveInteger(env.CRM_INBOUND_IMAP_MAX_SYNC_BYTES, DEFAULT_MAX_SYNC_BYTES, {
      min: 1024,
      max: MAX_SYNC_BYTES_LIMIT,
    }),
  };
  config.ready = Boolean(config.host && config.user && config.password && config.expectedRecipient);
  return config;
}

function addressList(value) {
  const list = Array.isArray(value?.value) ? value.value : [];
  return list.map((item) => clean(item?.address, 320).toLowerCase()).filter(Boolean);
}

function bodyText(parsed) {
  const plain = clean(parsed?.text, 4000);
  if (plain) return plain;
  return clean(String(parsed?.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 4000);
}

export function parsedEmailToCanonicalEvent(parsed, { uidValidity, uid, expectedRecipient } = {}) {
  const from = addressList(parsed?.from)[0] || '';
  const recipients = [...addressList(parsed?.to), ...addressList(parsed?.cc)];
  const expected = clean(expectedRecipient, 320).toLowerCase();
  const to = recipients.includes(expected) ? expected : recipients[0] || '';
  const body = bodyText(parsed);
  const subject = clean(parsed?.subject, 512);
  if (!from || !to || (expected && !recipients.includes(expected)) || (!subject && !body)) return null;
  const messageId = clean(parsed?.messageId, 512).replace(/^<|>$/g, '');
  const fallbackId = `${clean(uidValidity, 80) || 'mailbox'}:${clean(uid, 80)}`;
  return {
    externalId: messageId || fallbackId,
    from,
    to,
    subject,
    body,
    receivedAt: parsed?.date instanceof Date ? parsed.date.toISOString() : new Date().toISOString(),
  };
}

export function createCrmImapInboxSync({
  crmService,
  config = readCrmImapConfig(),
  logger = console,
  createClient = (options) => new ImapFlow(options),
  parseMessage = simpleParser,
  now = () => new Date(),
} = {}) {
  if (!crmService) throw new Error('CRM service is required');
  let timer = null;
  let running = false;
  let lastProcessedUid = 0;
  const maxMessageBytes = positiveInteger(config.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, {
    min: 1,
    max: MAX_MESSAGE_BYTES_LIMIT,
  });
  const maxSyncBytes = positiveInteger(config.maxSyncBytes, DEFAULT_MAX_SYNC_BYTES, {
    min: 1,
    max: MAX_SYNC_BYTES_LIMIT,
  });
  const maxMessages = positiveInteger(config.maxMessages, DEFAULT_MAX_MESSAGES, {
    min: 1,
    max: 500,
  });
  const maxMessagesPerSync = Math.max(1, Math.min(
    maxMessages,
    Math.floor(maxSyncBytes / (maxMessageBytes + 1)),
  ));

  async function syncOnce() {
    if (!config.enabled) return { status: 'disabled', processed: 0 };
    if (!config.ready) return { status: 'not_configured', processed: 0 };
    if (running) return { status: 'busy', processed: 0 };
    running = true;
    const client = createClient({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      logger: false,
      maxLiteralSize: maxMessageBytes + 1,
      maxResponseSize: maxMessageBytes + 64 * 1024,
    });
    let processed = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock(config.mailbox);
      try {
        const since = new Date(now().getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);
        const uids = await client.search({ since }, { uid: true });
        const selected = uids
          .filter((uid) => Number.isSafeInteger(uid) && uid > lastProcessedUid)
          .sort((left, right) => left - right)
          .slice(0, maxMessagesPerSync);
        if (!selected.length) return { status: 'ok', processed };
        const query = {
          uid: true,
          source: { start: 0, maxLength: maxMessageBytes + 1 },
        };
        for await (const message of client.fetch(selected, query, { uid: true })) {
          if (!Buffer.isBuffer(message.source) || message.source.length > maxMessageBytes) {
            logger?.warn?.('[crm-imap-inbound] message skipped', {
              reason: 'message_too_large_or_invalid',
              uid: clean(message.uid, 80),
            });
            lastProcessedUid = Math.max(lastProcessedUid, Number(message.uid) || 0);
            continue;
          }
          const parsed = await parseMessage(message.source);
          const event = parsedEmailToCanonicalEvent(parsed, {
            uidValidity: client.mailbox?.uidValidity,
            uid: message.uid,
            expectedRecipient: config.expectedRecipient,
          });
          if (!event) {
            lastProcessedUid = Math.max(lastProcessedUid, Number(message.uid) || 0);
            continue;
          }
          await crmService.ingestInbound({
            source: 'email',
            sourceId: event.externalId,
            channel: 'email',
            email: event.from,
            phone: null,
            identityUsed: event.from,
            origin: 'institutional_email',
            subject: event.subject,
            body: event.body,
            receivedAt: event.receivedAt,
          });
          processed += 1;
          lastProcessedUid = Math.max(lastProcessedUid, Number(message.uid) || 0);
        }
      } finally {
        lock.release();
      }
      return { status: 'ok', processed };
    } catch (error) {
      logger?.error?.('[crm-imap-inbound] sync failed', { message: clean(error?.message, 240) });
      return { status: 'error', processed };
    } finally {
      running = false;
      try { await client.logout(); } catch {}
    }
  }

  function start() {
    if (!config.enabled || !config.ready || timer) return false;
    void syncOnce();
    timer = setInterval(() => { void syncOnce(); }, config.intervalMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return { config, syncOnce, start, stop };
}
