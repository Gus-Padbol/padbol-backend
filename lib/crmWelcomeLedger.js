// Bounded CRM welcome ledger (additive, server-only).
// Contract: contract-20261111 §2/§4/§5.
// - One durable claim per contact for purpose='welcome' (DB UNIQUE), claimed BEFORE
//   any provider attempt. New sourceIds, conversations, restarts or concurrent
//   workers cannot produce a second send.
// - No raw recipient, email, body or token is stored here. No local conversation
//   identity is stored either: the contact is the only identity.
// - OFF is evaluated before the claim, the provider key and the provider call.
// - status: claimed -> accepted | uncertain | rejected. Terminal states never
//   release the claim; uncertain stays suppressed pending explicit reconciliation.

import { createHash } from 'node:crypto';

export const WELCOME_PURPOSE = 'welcome';
export const LEDGER_STATUSES = Object.freeze(['claimed', 'accepted', 'uncertain', 'rejected']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_KEY = /^[a-z0-9][a-z0-9:_-]{0,119}$/;

function assertContact(contactId) {
  if (typeof contactId !== 'string' || !UUID.test(contactId)) {
    throw Object.assign(new Error('WELCOME_CONTACT_INVALID'), { code: 'WELCOME_CONTACT_INVALID', status: 400 });
  }
}
function assertProviderKey(providerKey) {
  if (typeof providerKey !== 'string' || !PROVIDER_KEY.test(providerKey)) {
    throw Object.assign(new Error('WELCOME_PROVIDER_KEY_INVALID'), { code: 'WELCOME_PROVIDER_KEY_INVALID', status: 400 });
  }
}

// Server-derived, stable provider key for one purpose. No PII: only the contact
// uuid (already opaque) and the fixed purpose string are hashed.
export function welcomeProviderKey(contactId, purpose = WELCOME_PURPOSE) {
  assertContact(contactId);
  if (purpose !== WELCOME_PURPOSE) throw Object.assign(new Error('WELCOME_PURPOSE_INVALID'), { code: 'WELCOME_PURPOSE_INVALID', status: 400 });
  return `padbol-lead-welcome-${createHash('sha256').update(contactId.toLowerCase()).digest('hex')}`;
}

// Opaque, server-only identity for downstream receipts: the contact uuid carries no
// email/phone/body. `contactRef` is a salted digest safe for logs.
export function welcomeReceipt(contactId, { salt = '', attemptId = null } = {}) {
  assertContact(contactId);
  const ref = `w_${Buffer.from(contactId.toLowerCase() + '|' + String(salt), 'utf8')
    .toString('base64url').slice(0, 22)}`;
  return Object.freeze({ contactId, contactRef: ref, attemptId, purpose: WELCOME_PURPOSE });
}

export function createCrmWelcomeLedger({ pool, now = () => new Date(), logger = console } = {}) {
  if (!pool?.query) throw new Error('WELCOME_LEDGER_POOL_REQUIRED');

  const at = () => new Date(now()).toISOString();

  // Claim BEFORE any provider attempt. `enabled` must be the already-evaluated
  // runtime gate; when false the ledger performs zero queries.
  async function claim({ contactId, providerKey, enabled }) {
    if (enabled !== true) return { claimed: false, status: 'disabled', reason: 'welcome_disabled' };
    assertContact(contactId);
    assertProviderKey(providerKey);
    const r = await pool.query(
      `insert into public.crm_welcome_ledger(contact_id,purpose,provider_key,status,claimed_at,updated_at)
       values($1,'welcome',$2,'claimed',$3,$3)
       on conflict (contact_id,purpose) do nothing
       returning attempt_id,status,claimed_at`,
      [contactId, providerKey, at()],
    );
    if (r.rowCount === 1) return { claimed: true, status: 'claimed', attemptId: r.rows[0].attempt_id, receipt: welcomeReceipt(contactId, { attemptId: r.rows[0].attempt_id }) };
    const existing = await pool.query(
      `select attempt_id,status,provider_key,claimed_at from public.crm_welcome_ledger where contact_id=$1 and purpose='welcome'`,
      [contactId],
    );
    return { claimed: false, status: existing.rows[0]?.status || 'unknown', attemptId: existing.rows[0]?.attempt_id || null, reason: 'welcome_already_claimed' };
  }

  async function transition(attemptId, from, to, extraSql = '', extraParams = []) {
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) throw new Error('WELCOME_ATTEMPT_INVALID');
    const params = [attemptId, to, at(), ...extraParams, from];
    const fromIndex = params.length; // $N = expected previous status
    const r = await pool.query(
      `update public.crm_welcome_ledger
          set status=$2, updated_at=$3 ${extraSql}
        where attempt_id=$1 and status=$${fromIndex}
        returning attempt_id,status`,
      params,
    );
    return { updated: r.rowCount === 1, status: r.rowCount === 1 ? to : 'unchanged' };
  }

  const markAccepted = ({ attemptId, providerMessageId }) => {
    if (typeof providerMessageId !== 'string' || providerMessageId.length < 1 || providerMessageId.length > 512) {
      throw Object.assign(new Error('WELCOME_PROVIDER_ID_INVALID'), { code: 'WELCOME_PROVIDER_ID_INVALID', status: 400 });
    }
    return transition(attemptId, 'claimed', 'accepted', ', accepted_at=$3, provider_message_id=$4', [providerMessageId])
      .catch(error => { logger?.error?.('[crm-welcome-ledger]', { code: 'RECEIPT_WRITE_FAILED' }); throw error; });
  };
  // Ambiguous or lost ack: stays suppressed. No expiry, no blind retry.
  const markUncertain = ({ attemptId }) => transition(attemptId, 'claimed', 'uncertain', ', uncertain_at=$3');
  // Definitive provider rejection is terminal too: identity is never rotated.
  const markRejected = ({ attemptId, code = null }) => transition(attemptId, 'claimed', 'rejected', ', rejected_at=$3, rejection_code=$4', [code === null ? null : String(code).slice(0, 80)]);

  async function read(contactId) {
    assertContact(contactId);
    const r = await pool.query(
      `select attempt_id,status,provider_key,claimed_at,updated_at,accepted_at,uncertain_at,rejected_at,provider_message_id
         from public.crm_welcome_ledger where contact_id=$1 and purpose='welcome'`,
      [contactId],
    );
    return r.rows[0] || null;
  }

  return { claim, markAccepted, markUncertain, markRejected, read, receipt: welcomeReceipt };
}
