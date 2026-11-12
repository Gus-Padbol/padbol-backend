import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { canonicalMessageId } from './crmEmailReturn.js';
import {normalizeEmail} from './crmContact.js';

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
    commercialRepliesOnly: env.CRM_INBOUND_IMAP_COMMERCIAL_REPLIES_ONLY === 'true',
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

export function parsedEmailToCanonicalEvent(parsed, { uidValidity, uid, expectedRecipient, sourceHash } = {}) {
  const from = addressList(parsed?.from)[0] || '';
  const recipients = [...addressList(parsed?.to), ...addressList(parsed?.cc)];
  const expected = clean(expectedRecipient, 320).toLowerCase();
  const to = recipients.includes(expected) ? expected : recipients[0] || '';
  const body = bodyText(parsed);
  const subject = clean(parsed?.subject, 512);
  if (!from || !to || (expected && !recipients.includes(expected)) || (!subject && !body)) return null;
  const messageId = clean(parsed?.messageId, 512).replace(/^<|>$/g, '');
  // Sin Message-ID, una huella canónica del contenido evita reingestar el
  // mismo correo como nuevo cuando UIDVALIDITY cambia y se reinicia el cursor.
  // El hash de la fuente completa (incluye adjuntos/headers) evita colisiones
  // por cuerpo truncado; si no se provee, se usa contenido canónico acotado.
  const contentHash = createHash('sha256').update([from, to, subject, body, parsed?.date instanceof Date ? parsed.date.toISOString() : ''].join('\n')).digest('hex');
  const fallbackId = sourceHash
    ? `raw-${String(sourceHash).slice(0, 32)}`
    : `content-${contentHash.slice(0, 32)}`;
  return {
    externalId: messageId || fallbackId,
    from,
    to,
    subject,
    body,
    receivedAt: parsed?.date instanceof Date ? parsed.date.toISOString() : new Date().toISOString(),
    ...(canonicalMessageId(parsed?.inReplyTo) ? {inReplyTo:canonicalMessageId(parsed.inReplyTo)} : {}),
    ...(parsed?.references ? {references:(Array.isArray(parsed.references) ? parsed.references : [parsed.references]).map(canonicalMessageId).filter(Boolean).slice(-30)} : {}),
  };
}

// Diagnostic classes are fixed enums: never log a mailbox response or raw error.
function imapFailureClass(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (['EAUTH', 'AUTHENTICATIONFAILED'].includes(code) || error?.authenticationFailed === true) return 'AUTHENTICATION';
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT'].includes(code)) return 'TIMEOUT';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(code)) return 'CONNECTION';
  if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) return 'TLS';
  if (code === '42501') return 'DATABASE_AUTHORIZATION';
  if (['42P01', '42703'].includes(code)) return 'DATABASE_SCHEMA';
  if (code === '23505') return 'DATABASE_CONSTRAINT';
  if (['40001', '40P01'].includes(code)) return 'DATABASE_RETRY';
  if (code.startsWith('08') && /^[0-9A-Z]{5}$/.test(code)) return 'DATABASE_CONNECTION';
  if (/^PGRST[0-9]{3}$/.test(code)) return 'DATABASE_API';
  if (error instanceof SyntaxError) return 'PARSE';
  return 'UNKNOWN';
}

export function createCrmImapInboxSync({
  crmService,
  config = readCrmImapConfig(),
  logger = console,
  createClient = (options) => new ImapFlow(options),
  parseMessage = simpleParser,
  now = () => new Date(),
  emailReturn = null,
  readCommercialSenders = null,
} = {}) {
  if (!crmService) throw new Error('CRM service is required');
  let timer = null;
  let running = false;
  let lastProcessedUid = 0;
  let lastUidValidity = null;
  const worker = config.origin === 'support_email' ? 'support' : 'institutional';
  function diagnostic(level, event, fields) {
    // Diagnostics must not interrupt the mailbox lifecycle, even if a logger fails.
    try { logger?.[level]?.(`[crm-imap-inbound] ${event} ${JSON.stringify({worker, ...fields, at: new Date(now()).toISOString()})}`); } catch {}
  }

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
    let stage = 'scope';
    let outcome = 'ok';
    const result = status => { outcome = status; return {status, processed}; };
    try {
      // Durable correlation also runs when IMAP has no new UID after restart.
      let allowedSenders=null,commercialAddresses=null;
      if(config.commercialRepliesOnly){
        if(typeof readCommercialSenders!=='function')return result('commercial_scope_unavailable');
        // Empty/unavailable scope does not open the mailbox or touch a cursor.
        const addresses=await readCommercialSenders();
        if(!Array.isArray(addresses)||!addresses.length)return result('commercial_scope_empty');
        commercialAddresses=validatedCommercialAddresses(addresses);
        if(!commercialAddresses.length)return result('commercial_scope_empty');
        allowedSenders=new Set(commercialAddresses.map(normalizeEmail));
      }
      stage = 'reconcile';
      await emailReturn?.reconcilePending?.();
      stage = 'connect';
      await client.connect();
      stage = 'select';
      const lock = await client.getMailboxLock(config.mailbox, config.readOnly ? { readOnly: true } : undefined);
      try {
        // ImapFlow recién expone el buzón seleccionado después del lock/select.
        const uidValidity = String(client.mailbox?.uidValidity ?? '');
        if (lastUidValidity !== null && uidValidity && uidValidity !== lastUidValidity) {
          // UIDVALIDITY cambió (buzón recreado/reindexado): los UIDs previos ya no
          // son comparables. Reiniciar el cursor evita omitir correo nuevo.
          lastProcessedUid = 0;
        }
        if (uidValidity) lastUidValidity = uidValidity;
        const since = new Date(now().getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);
        stage = 'search';
        const uids = config.commercialRepliesOnly
          ? [...new Set((await Promise.all(commercialSearchChunks(commercialAddresses).map(or=>client.search({since,or},{uid:true})))).flat())]
          : await client.search({ since }, { uid: true });
        const selected = uids
          .filter((uid) => Number.isSafeInteger(uid) && uid > lastProcessedUid)
          .sort((left, right) => left - right)
          .slice(0, maxMessagesPerSync);
        if (!selected.length) return result('ok');
        const query = {
          uid: true,
          source: { start: 0, maxLength: maxMessageBytes + 1 },
        };
        stage = 'fetch';
        for await (const message of client.fetch(selected, query, { uid: true })) {
          if (!Buffer.isBuffer(message.source) || message.source.length > maxMessageBytes) {
            diagnostic('warn', 'message skipped', {stage: 'fetch', class: 'MESSAGE_TOO_LARGE_OR_INVALID', reason: 'message_too_large_or_invalid'});
            lastProcessedUid = Math.max(lastProcessedUid, Number(message.uid) || 0);
            continue;
          }
          stage = 'parse';
          const parsed = await parseMessage(message.source);
          const sourceHash = createHash('sha256').update(message.source).digest('hex');
          const event = parsedEmailToCanonicalEvent(parsed, {
            uidValidity: client.mailbox?.uidValidity,
            uid: message.uid,
            expectedRecipient: config.expectedRecipient,
            sourceHash,
          });
          if (!event) {
            lastProcessedUid = Math.max(lastProcessedUid, Number(message.uid) || 0);
            stage = 'fetch';
            continue;
          }
          if(allowedSenders && !allowedSenders.has(normalizeEmail(event.from))){
            lastProcessedUid=Math.max(lastProcessedUid,Number(message.uid)||0);
            stage = 'fetch';
            continue;
          }
          stage = 'correlate';
          const threaded = await emailReturn?.ingestReply?.(event);
          if (threaded?.matched) {
            processed += 1;
            lastProcessedUid = Math.max(lastProcessedUid, Number(message.uid) || 0);
            stage = 'fetch';
            continue;
          }
          stage = 'ingest';
          const ingested = await crmService.ingestInbound({
            source: config.source || 'email',
            sourceId: event.externalId,
            channel: 'email',
            email: event.from,
            phone: null,
            identityUsed: event.from,
            origin: config.origin || 'institutional_email',
            subject: event.subject,
            body: event.body,
            receivedAt: event.receivedAt,
            qualificationData: config.qualificationData || {},
          });
          stage = 'fallback';
          if (ingested?.status !== 'idempotent') await emailReturn?.afterFallback?.(event);
          processed += 1;
          lastProcessedUid = Math.max(lastProcessedUid, Number(message.uid) || 0);
          stage = 'fetch';
        }
      } finally {
        lock.release();
      }
      return result('ok');
    } catch (error) {
      diagnostic('error', 'sync failed', {status: 'error', stage, class: imapFailureClass(error), processed});
      return result('error');
    } finally {
      running = false;
      try { await client.logout(); } catch {}
      if (outcome !== 'error') diagnostic('info', 'sync completed', {status: outcome, stage: outcome === 'ok' ? 'complete' : 'scope', processed});
    }
  }

  function start() {
    if (timer) return false;
    diagnostic('info', 'startup', {enabled: config.enabled === true, ready: config.ready === true, status: !config.enabled ? 'disabled' : !config.ready ? 'not_configured' : 'started'});
    if (!config.enabled || !config.ready) return false;
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

function validatedCommercialAddresses(addresses){
 if(addresses.length>1000)throw new Error('Commercial sender scope too large');
 if(addresses.some(x=>typeof x!=='string'||x.length>320||!/^[-a-zA-Z0-9.!#$%&'*+/=?^_`{|}~]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(x)))throw new Error('Invalid commercial sender scope');
 return [...new Set(addresses.map(x=>x.toLowerCase()))];
}
function commercialSearchChunks(addresses){const result=[];for(let i=0;i<addresses.length;i+=25)result.push(addresses.slice(i,i+25).map(from=>({from})));return result;}
