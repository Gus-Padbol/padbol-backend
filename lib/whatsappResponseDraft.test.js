import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createResponseDraft, validateResponseDraft, reviseResponseDraft, previewResponseDraft,
} from './whatsappResponseDraft.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/synthetic-draft.json', import.meta.url), 'utf8'));
const clone = (value = fixture) => structuredClone(value);
const context = (draft = fixture) => ({ tenantId: draft.tenantId, draftId: draft.draftId, revision: draft.revision, locale: draft.locale });
const preview = (draft = fixture, event = { kind: 'greeting' }, ctx = context(draft)) => previewResponseDraft(draft, event, ctx);
const rejected = (result, code) => {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.previewOnly, true);
  assert.equal(Object.hasOwn(result, 'text'), false);
};

test('empty drafts are saveable but incomplete and disabled', () => {
  const result = createResponseDraft(context());
  assert.equal(result.ok, true);
  assert.equal(result.draft.revision, 1);
  assert.equal(result.draft.enabled, false);
  assert.equal(result.draft.status, 'draft');
  assert.equal(result.validation.complete, false);
  assert.equal(result.validation.missing.length, 5);
  assert.equal(result.validation.dispatchAllowed, false);
  rejected(preview(result.draft), 'INCOMPLETE_DRAFT');
});

test('invalid draft identity is rejected without inventing IDs or a locale', () => {
  for (const args of [{}, { ...context(), tenantId: 'other' }, { ...context(), locale: 'es-AR<script>' }]) {
    rejected(createResponseDraft(args), 'INVALID_DRAFT');
  }
});

test('complete synthetic fixture validates without permission to dispatch', () => {
  assert.deepEqual(validateResponseDraft(fixture), { valid: true, complete: true, dispatchAllowed: false, errors: [], missing: [] });
  assert.equal(preview().contentStatus, 'synthetic');
});

test('all preview sections resolve deterministically and remain inert', () => {
  const cases = [
    [{ kind: 'greeting' }, fixture.greeting.text],
    [{ kind: 'fallback' }, fixture.fallback.text],
    [{ kind: 'topic', id: 'example_topic' }, fixture.savedReplies[0].text],
    [{ kind: 'saved_reply', id: 'example_reply' }, fixture.savedReplies[0].text],
    [{ kind: 'human_request' }, fixture.humanHandoff.text],
  ];
  for (const [event, expected] of cases) {
    const result = preview(fixture, event);
    assert.equal(result.ok, true);
    assert.equal(result.text, expected);
    assert.equal(result.dispatchAllowed, false);
    assert.equal(result.previewOnly, true);
    assert.deepEqual(result, preview(fixture, event));
  }
  const human = preview(fixture, { kind: 'human_request' });
  assert.equal(human.proposedAction, 'request_human_attention');
  assert.equal(human.actionPerformed, false);
  assert.deepEqual(preview(fixture, { kind: 'menu' }).options, [{ id: 'example_topic', label: fixture.topics[0].label, ready: true }]);
});

test('partial content can be previewed; missing content is explicit and never filled in', () => {
  const draft = clone();
  draft.fallback = null;
  draft.topics[0].savedReplyId = null;
  const result = preview(draft);
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.equal(result.missing.length, 2);
  assert.equal(preview(draft, { kind: 'menu' }).options[0].ready, false);
  rejected(preview(draft, { kind: 'topic', id: 'example_topic' }), 'INCOMPLETE_DRAFT');
  rejected(preview(draft, { kind: 'fallback' }), 'INCOMPLETE_DRAFT');
  draft.humanHandoff = null;
  rejected(preview(draft, { kind: 'human_request' }), 'INCOMPLETE_DRAFT');
});

test('tenant, draft, revision and locale must match before any content is returned', () => {
  const variants = [
    [{ tenantId: '00000000-0000-4000-8000-000000000099' }, 'TENANT_MISMATCH'],
    [{ draftId: '00000000-0000-4000-8000-000000000099' }, 'DRAFT_MISMATCH'],
    [{ revision: 2 }, 'REVISION_CONFLICT'],
    [{ locale: 'en' }, 'LOCALE_MISMATCH'],
  ];
  for (const [changes, code] of variants) {
    const ctx = { ...context(), ...changes };
    rejected(preview(fixture, { kind: 'greeting' }, ctx), code);
    rejected(reviseResponseDraft(fixture, { greeting: null }, ctx), code);
  }
});

test('missing or malformed context is rejected, and extra raw conversation data is forbidden', () => {
  for (const ctx of [null, {}, { ...context(), revision: '1' }, { ...context(), revision: Infinity },
    { ...context(), text: 'private input' }, { ...context(), recipient: '555' }, { ...context(), channelId: 'anything' },
    { ...context(), locale: 'es\n' }, { ...context(), tenantId: fixture.tenantId + '\n' }]) {
    rejected(previewResponseDraft(fixture, { kind: 'greeting' }, ctx), 'INVALID_CONTEXT');
  }
  for (const key of Object.keys(context())) {
    const ctx = context(); delete ctx[key];
    rejected(previewResponseDraft(fixture, { kind: 'greeting' }, ctx), 'INVALID_CONTEXT');
  }
});

test('unsupported versions, active states and approval assertions are rejected', () => {
  for (const changes of [{ schemaVersion: 2 }, { schemaVersion: '1' }, { revision: 0 },
    { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { enabled: true },
    { status: 'published' }, { contentStatus: 'approved' }, { locale: 'es\n' }, { tenantId: fixture.tenantId + '\n' }]) {
    const draft = { ...clone(), ...changes };
    assert.equal(validateResponseDraft(draft).valid, false);
    rejected(preview(draft), 'INVALID_DRAFT');
  }
});

test('duplicate IDs, dangling replies and arbitrary target fields are rejected', () => {
  const cases = [];
  let draft = clone(); draft.topics.push({ ...draft.topics[0] }); cases.push(draft);
  draft = clone(); draft.savedReplies.push({ ...draft.savedReplies[0] }); cases.push(draft);
  draft = clone(); draft.topics[0].savedReplyId = 'absent'; cases.push(draft);
  draft = clone(); draft.savedReplies[0].id = 'invalid key'; cases.push(draft);
  draft = clone(); draft.humanHandoff.operatorId = 'invented'; cases.push(draft);
  draft = clone(); draft.toWaId = '555'; cases.push(draft);
  draft = clone(); draft.channelId = 'live'; cases.push(draft);
  draft = clone(); draft.greeting.endpoint = 'https://example.invalid'; cases.push(draft);
  for (draft of cases) assert.equal(validateResponseDraft(draft).valid, false);
});

test('limits, empty content, malformed JSON structures and synthetic markings are enforced', () => {
  const cases = [];
  let draft = clone(); draft.greeting.text = ' '; cases.push(draft);
  draft = clone(); draft.greeting.text = '[SINTÉTICO] '; cases.push(draft);
  draft = clone(); draft.greeting.text = 'Unlabelled example'; cases.push(draft);
  draft = clone(); draft.greeting.text = '[SINTÉTICO] ' + 'x'.repeat(2000); cases.push(draft);
  draft = clone(); draft.topics[0].label = '[SINTÉTICO] ' + 'x'.repeat(160); cases.push(draft);
  draft = clone(); draft.topics = Array(51).fill(fixture.topics[0]); cases.push(draft);
  draft = clone(); draft.savedReplies = Array(1); cases.push(draft);
  draft = clone(); draft.topics.extra = 'x'; cases.push(draft);
  draft = clone(); delete draft.fallback; cases.push(draft);
  draft = clone(); draft.greeting = new Date(); cases.push(draft);
  for (const candidate of [null, [], Object.create(fixture), ...cases]) assert.equal(validateResponseDraft(candidate).valid, false);
});

test('accessors are rejected without execution at draft, section and array levels', () => {
  let calls = 0;
  for (const target of ['draft', 'section', 'array']) {
    const draft = clone();
    const object = target === 'draft' ? draft : target === 'section' ? draft.greeting : draft.topics;
    const key = target === 'draft' ? 'greeting' : target === 'section' ? 'text' : '0';
    Object.defineProperty(object, key, { get() { calls++; throw new Error('Must not execute'); }, enumerable: true });
    assert.equal(validateResponseDraft(draft).valid, false);
  }
  assert.equal(calls, 0);
});

test('unknown events and selections never fall back silently or infer business intent', () => {
  rejected(preview(fixture, { kind: 'topic', id: 'other' }), 'UNKNOWN_TOPIC');
  rejected(preview(fixture, { kind: 'saved_reply', id: 'other' }), 'UNKNOWN_SAVED_REPLY');
  for (const event of [{ kind: 'send' }, { kind: 'greeting', id: 'example' }, { kind: 'topic' },
    { kind: 'fallback', text: 'private inbound' }, { kind: 'greeting', to: '555' }, null, 'hola']) {
    rejected(preview(fixture, event), 'INVALID_EVENT');
  }
});

test('local revisions increment once, preserve scope and reject stale or immutable changes', () => {
  const original = clone();
  const changes = { greeting: { text: '[SINTÉTICO] Segunda revisión.' } };
  const result = reviseResponseDraft(original, changes, context(original));
  assert.equal(result.ok, true);
  assert.equal(result.draft.revision, 2);
  assert.equal(original.revision, 1);
  assert.equal(original.greeting.text, fixture.greeting.text);
  assert.equal(result.draft.tenantId, original.tenantId);
  assert.equal(result.draft.enabled, false);
  changes.greeting.text = 'Changed outside';
  assert.equal(result.draft.greeting.text, '[SINTÉTICO] Segunda revisión.');
  rejected(reviseResponseDraft(result.draft, { greeting: null }, context(original)), 'REVISION_CONFLICT');
  rejected(preview(result.draft, { kind: 'greeting' }, context(original)), 'REVISION_CONFLICT');
  assert.equal(preview(result.draft).text, '[SINTÉTICO] Segunda revisión.');
  for (const changes of [{}, { tenantId: original.tenantId }, { draftId: original.draftId }, { revision: 9 },
    { enabled: true }, { schemaVersion: 2 }, { status: 'active' }]) {
    rejected(reviseResponseDraft(original, changes, context(original)), 'INVALID_CHANGES');
  }
});

test('revisions refuse invalid edited content and integer exhaustion', () => {
  rejected(reviseResponseDraft(fixture, { topics: [{ ...fixture.topics[0], savedReplyId: 'absent' }] }, context()), 'INVALID_DRAFT');
  const draft = clone(); draft.revision = Number.MAX_SAFE_INTEGER;
  rejected(reviseResponseDraft(draft, { greeting: null }, context(draft)), 'REVISION_EXHAUSTED');
});

test('unapproved text is preserved literally, with no template expansion or auto approval', () => {
  const draft = clone();
  draft.contentStatus = 'unapproved';
  draft.greeting.text = 'Texto pendiente de revisión: {{operador}} ${precio} <b>literal</b>';
  const result = preview(draft);
  assert.equal(result.text, draft.greeting.text);
  assert.equal(result.contentStatus, 'unapproved');
  assert.equal(result.dispatchAllowed, false);
  assert.equal(Object.hasOwn(result, 'html'), false);
});

test('text limits count Unicode code points consistently with JSON Schema', () => {
  const draft = clone(); draft.contentStatus = 'unapproved';
  draft.greeting.text = '😀'.repeat(2000);
  assert.equal(validateResponseDraft(draft).valid, true);
  assert.equal(preview(draft).text, draft.greeting.text);
  draft.greeting.text += '😀';
  assert.equal(validateResponseDraft(draft).valid, false);
});

test('valid JSON with prototype-related keys is rejected, without prototype pollution', () => {
  const draft = JSON.parse(JSON.stringify(fixture).replace('"schemaVersion":1', '"__proto__":{"polluted":true},"schemaVersion":1'));
  assert.equal(validateResponseDraft(draft).valid, false);
  assert.equal({}.polluted, undefined);
});

test('results are detached and source drafts are not mutated', () => {
  const draft = clone();
  const before = JSON.stringify(draft);
  const menu = preview(draft, { kind: 'menu' });
  menu.options[0].label = 'Modified preview';
  const created = reviseResponseDraft(draft, { fallback: null }, context(draft));
  created.draft.topics[0].label = 'Modified revised draft';
  assert.equal(JSON.stringify(draft), before);
});

test('preview and error diagnostics do not expose extra context or a delivery payload', () => {
  const result = preview(fixture, { kind: 'human_request' });
  for (const key of ['to', 'toWaId', 'recipient', 'channelId', 'phone', 'payload', 'headers', 'tenantId', 'operatorId', 'send']) {
    assert.equal(Object.hasOwn(result, key), false);
  }
  const privateText = 'UNIQUE_PRIVATE_INPUT';
  const error = preview(fixture, { kind: 'fallback', text: privateText });
  assert.equal(JSON.stringify(error).includes(privateText), false);
  const wrongTenant = preview(fixture, { kind: 'greeting' }, { ...context(), tenantId: '00000000-0000-4000-8000-000000000099' });
  assert.equal(JSON.stringify(wrongTenant).includes(fixture.greeting.text), false);
});
