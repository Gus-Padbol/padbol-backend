// Pure draft contract. No storage, authorization, provider or runtime integration.
export const RESPONSE_DRAFT_SCHEMA_VERSION = 1;
// The final assertion rejects trailing newlines too (unlike JavaScript's `$`).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const KEY = /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?(?![\s\S])/;
const SYNTHETIC_PREFIX = '[SINTÉTICO] ';
const TOP_KEYS = ['schemaVersion', 'tenantId', 'draftId', 'revision', 'status', 'enabled',
  'locale', 'contentStatus', 'greeting', 'topics', 'savedReplies', 'fallback', 'humanHandoff'];
const CONTEXT_KEYS = ['tenantId', 'draftId', 'revision', 'locale'];
const EDITABLE_KEYS = ['locale', 'contentStatus', 'greeting', 'topics', 'savedReplies', 'fallback', 'humanHandoff'];
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const issue = (path, code) => ({ path, code });

// JSON records only: no inherited configuration, accessor execution or opaque values.
function record(value, allowed, errors, path, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    errors.push(issue(path, 'OBJECT_REQUIRED'));
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
    || !allowed.includes(key) || !has(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    errors.push(issue(path, 'UNKNOWN_OR_NON_JSON_FIELD'));
    return false;
  }
  for (const key of required) if (!has(value, key)) errors.push(issue(`${path}.${key}`, 'FIELD_REQUIRED'));
  return required.every(key => has(value, key));
}

function list(value, errors, path) {
  if (!Array.isArray(value) || value.length > 50
    || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({ length: value.length }, (_, index) => index).some(index => {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      return !descriptor || !has(descriptor, 'value');
    })) {
    errors.push(issue(path, 'DENSE_ARRAY_MAX_50_REQUIRED'));
    return false;
  }
  return true;
}

function nonEmptyText(text, maximum, synthetic, errors, path) {
  if (typeof text !== 'string' || !text.trim() || [...text].length > maximum) {
    errors.push(issue(path, 'NONEMPTY_TEXT_WITHIN_LIMIT_REQUIRED'));
  } else if (synthetic && (!text.startsWith(SYNTHETIC_PREFIX) || !text.slice(SYNTHETIC_PREFIX.length).trim())) {
    errors.push(issue(path, 'SYNTHETIC_LABEL_REQUIRED'));
  }
}

export function validateResponseDraft(draft) {
  const errors = [];
  const missing = [];
  if (record(draft, TOP_KEYS, errors, '$')) {
    if (draft.schemaVersion !== RESPONSE_DRAFT_SCHEMA_VERSION) errors.push(issue('$.schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION'));
    for (const key of ['tenantId', 'draftId']) {
      if (typeof draft[key] !== 'string' || !UUID.test(draft[key])) errors.push(issue(`$.${key}`, 'LOWERCASE_UUID_REQUIRED'));
    }
    if (!Number.isSafeInteger(draft.revision) || draft.revision < 1) errors.push(issue('$.revision', 'POSITIVE_SAFE_INTEGER_REQUIRED'));
    if (draft.status !== 'draft' || draft.enabled !== false) errors.push(issue('$', 'DISABLED_DRAFT_ONLY'));
    if (typeof draft.locale !== 'string' || !LOCALE.test(draft.locale)) errors.push(issue('$.locale', 'SUPPORTED_LOCALE_FORMAT_REQUIRED'));
    if (!['synthetic', 'unapproved'].includes(draft.contentStatus)) errors.push(issue('$.contentStatus', 'UNAPPROVED_CONTENT_ONLY'));
    const synthetic = draft.contentStatus === 'synthetic';
    for (const key of ['greeting', 'fallback', 'humanHandoff']) {
      const path = `$.${key}`;
      if (draft[key] === null) missing.push(issue(path, 'CONTENT_MISSING'));
      else if (record(draft[key], ['text'], errors, path)) nonEmptyText(draft[key].text, 2000, synthetic, errors, `${path}.text`);
    }
    const replyIds = new Set();
    if (list(draft.savedReplies, errors, '$.savedReplies')) {
      if (!draft.savedReplies.length) missing.push(issue('$.savedReplies', 'CONTENT_MISSING'));
      draft.savedReplies.forEach((reply, index) => {
        const path = `$.savedReplies[${index}]`;
        if (!record(reply, ['id', 'text'], errors, path)) return;
        if (typeof reply.id !== 'string' || !KEY.test(reply.id)) errors.push(issue(`${path}.id`, 'KEY_REQUIRED'));
        if (replyIds.has(reply.id)) errors.push(issue(`${path}.id`, 'DUPLICATE_REPLY_ID'));
        replyIds.add(reply.id);
        nonEmptyText(reply.text, 2000, synthetic, errors, `${path}.text`);
      });
    }
    const topicIds = new Set();
    if (list(draft.topics, errors, '$.topics')) {
      if (!draft.topics.length) missing.push(issue('$.topics', 'CONTENT_MISSING'));
      draft.topics.forEach((topic, index) => {
        const path = `$.topics[${index}]`;
        if (!record(topic, ['id', 'label', 'savedReplyId'], errors, path)) return;
        if (typeof topic.id !== 'string' || !KEY.test(topic.id)) errors.push(issue(`${path}.id`, 'KEY_REQUIRED'));
        if (topicIds.has(topic.id)) errors.push(issue(`${path}.id`, 'DUPLICATE_TOPIC_ID'));
        topicIds.add(topic.id);
        nonEmptyText(topic.label, 160, synthetic, errors, `${path}.label`);
        if (topic.savedReplyId === null) missing.push(issue(`${path}.savedReplyId`, 'REPLY_NOT_SELECTED'));
        else if (typeof topic.savedReplyId !== 'string' || !KEY.test(topic.savedReplyId) || !replyIds.has(topic.savedReplyId)) {
          errors.push(issue(`${path}.savedReplyId`, 'UNKNOWN_SAVED_REPLY'));
        }
      });
    }
  }
  return { valid: errors.length === 0, complete: errors.length === 0 && missing.length === 0,
    dispatchAllowed: false, errors, missing };
}

function failure(code, details = []) {
  // Diagnostics contain field paths and codes, never draft text or supplied context.
  return { ok: false, previewOnly: true, dispatchAllowed: false, code, issues: details };
}

function validateContext(draft, context) {
  const errors = [];
  if (!record(context, CONTEXT_KEYS, errors, '$context')) return failure('INVALID_CONTEXT', errors);
  if (typeof context.tenantId !== 'string' || !UUID.test(context.tenantId)
    || typeof context.draftId !== 'string' || !UUID.test(context.draftId)
    || !Number.isSafeInteger(context.revision) || context.revision < 1
    || typeof context.locale !== 'string' || !LOCALE.test(context.locale)) return failure('INVALID_CONTEXT');
  if (draft.tenantId !== context.tenantId) return failure('TENANT_MISMATCH');
  if (draft.draftId !== context.draftId) return failure('DRAFT_MISMATCH');
  if (draft.revision !== context.revision) return failure('REVISION_CONFLICT');
  if (draft.locale !== context.locale) return failure('LOCALE_MISMATCH');
  return null;
}

// Creates an empty, saveable draft; IDs come from the caller, not a clock or RNG.
export function createResponseDraft({ tenantId, draftId, locale } = {}) {
  const draft = { schemaVersion: RESPONSE_DRAFT_SCHEMA_VERSION, tenantId, draftId, revision: 1,
    status: 'draft', enabled: false, locale, contentStatus: 'synthetic', greeting: null,
    topics: [], savedReplies: [], fallback: null, humanHandoff: null };
  const validation = validateResponseDraft(draft);
  return validation.valid ? { ok: true, dispatchAllowed: false, draft, validation }
    : failure('INVALID_DRAFT', validation.errors);
}

// Pure optimistic revision check. A future storage layer MUST compare-and-swap
// the persisted revision atomically; this helper alone is not a concurrency lock.
export function reviseResponseDraft(draft, changes, context) {
  const validation = validateResponseDraft(draft);
  if (!validation.valid) return failure('INVALID_DRAFT', validation.errors);
  const contextError = validateContext(draft, context);
  if (contextError) return contextError;
  const errors = [];
  if (!record(changes, EDITABLE_KEYS, errors, '$changes', []) || errors.length || !Object.keys(changes).length) {
    return failure('INVALID_CHANGES', errors);
  }
  if (draft.revision === Number.MAX_SAFE_INTEGER) return failure('REVISION_EXHAUSTED');
  const candidate = { ...draft, ...changes, revision: draft.revision + 1 };
  const nextValidation = validateResponseDraft(candidate);
  if (!nextValidation.valid) return failure('INVALID_DRAFT', nextValidation.errors);
  return { ok: true, dispatchAllowed: false, draft: structuredClone(candidate), validation: nextValidation };
}

// Explicit UI selections only. No raw incoming message, recipient, phone, sender,
// webhook payload, history, template expansion, inferred intent, or dispatch token.
export function previewResponseDraft(draft, event, context) {
  const validation = validateResponseDraft(draft);
  if (!validation.valid) return failure('INVALID_DRAFT', validation.errors);
  const contextError = validateContext(draft, context);
  if (contextError) return contextError;
  const errors = [];
  if (!record(event, ['kind', 'id'], errors, '$event', ['kind'])) return failure('INVALID_EVENT', errors);
  const selected = ['topic', 'saved_reply'].includes(event.kind);
  if (!['greeting', 'menu', 'topic', 'saved_reply', 'fallback', 'human_request'].includes(event.kind)
    || (selected ? typeof event.id !== 'string' || !KEY.test(event.id) : has(event, 'id'))) return failure('INVALID_EVENT');
  let text;
  let options;
  if (event.kind === 'menu') {
    if (!draft.topics.length) return failure('INCOMPLETE_DRAFT', [issue('$.topics', 'CONTENT_MISSING')]);
    options = draft.topics.map(topic => ({ id: topic.id, label: topic.label, ready: topic.savedReplyId !== null }));
  } else if (selected) {
    let replyId = event.id;
    if (event.kind === 'topic') {
      const topic = draft.topics.find(item => item.id === event.id);
      if (!topic) return failure('UNKNOWN_TOPIC');
      if (topic.savedReplyId === null) return failure('INCOMPLETE_DRAFT', [issue('$.topics', 'REPLY_NOT_SELECTED')]);
      replyId = topic.savedReplyId;
    }
    const reply = draft.savedReplies.find(item => item.id === replyId);
    if (!reply) return failure('UNKNOWN_SAVED_REPLY');
    text = reply.text;
  } else {
    const section = event.kind === 'human_request' ? 'humanHandoff' : event.kind;
    if (draft[section] === null) return failure('INCOMPLETE_DRAFT', [issue(`$.${section}`, 'CONTENT_MISSING')]);
    text = draft[section].text;
  }
  return { ok: true, previewOnly: true, dispatchAllowed: false, schemaVersion: draft.schemaVersion,
    draftId: draft.draftId, revision: draft.revision, locale: draft.locale, contentStatus: draft.contentStatus,
    kind: event.kind, complete: validation.complete, missing: validation.missing,
    ...(options ? { options } : { text }),
    ...(event.kind === 'human_request' ? { proposedAction: 'request_human_attention', actionPerformed: false } : {}) };
}
