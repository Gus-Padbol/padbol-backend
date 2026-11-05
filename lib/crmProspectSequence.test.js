import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyProspectReply, sequenceLanguage, sequenceSteps, stopSequenceFor, statusForClassification } from './crmProspectSequence.js';

test('clasifica las siete respuestas comerciales y detiene la secuencia', () => {
  const cases = [
    ['I am interested, tell me more', 'interested'],
    ['Please send information about the Academy', 'information_request'],
    ['Can you send a price and proposal?', 'price_request'],
    ['Can we schedule a call next week?', 'meeting_request'],
    ['No thanks, not interested', 'not_interested'],
    ['Please unsubscribe me', 'opt_out'],
    ['We received your message', 'ambiguous'],
  ];
  for (const [text, expected] of cases) {
    const classification = classifyProspectReply(text);
    assert.equal(classification, expected, text);
    assert.equal(statusForClassification(classification).length > 0, true);
    assert.equal(stopSequenceFor(classification), true);
  }
  assert.equal(classifyProspectReply('Mailer-daemon: address not found'), 'bounce');
});

test('cinco pasos ES/EN, firma y enlace de experiencia', () => {
  const es = sequenceSteps('es');
  assert.deepEqual(es.map(step => step.day), [0, 1, 3, 7, 14]);
  assert.match(es[0].body, /Nicolás Renedo/);
  assert.match(es[0].body, /BAJA/);
  assert.match(es[0].body, /\{\{experienceUrl\}\}/);
  const en = sequenceSteps('en');
  assert.match(en[4].body, /pioneer/);
  assert.match(en[2].body, /UNSUBSCRIBE/);
  assert.equal(sequenceLanguage('AR'), 'es');
  assert.equal(sequenceLanguage('DE'), 'en');
  assert.equal(sequenceLanguage('US', 'es'), 'es');
});
