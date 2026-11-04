import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnsubscribeToken, renderSequenceMessage, sequenceSteps, verifyUnsubscribeToken } from './crmProspectSequence.js';

const SUBJECTS = {
  es: ['Una nueva oportunidad deportiva y comercial para su club', '¿Cómo puede Padbol generar nuevas oportunidades para su club?', 'Sea pionero de Padbol en su ciudad'],
  en: ['A new sports and business opportunity for your club', 'How can Padbol create new opportunities for your club?', 'Be a Padbol pioneer in your city'],
};

test('seis asuntos aprobados y firma en los tres pasos', () => {
  for (const language of ['es', 'en']) {
    const steps = sequenceSteps(language);
    assert.deepEqual(steps.map(step => step.subject), SUBJECTS[language]);
    for (const step of steps) {
      assert.match(step.body, /Nicolás Renedo/);
      assert.match(step.body, /Padbol International/);
      assert.match(step.body, /info@padbol\.com/);
      assert.match(step.body, /BAJA|UNSUBSCRIBE/);
      assert.match(step.body, /\{\{experienceUrl\}\}/);
    }
  }
});

test('personaliza contacto y club y conserva el enlace solo si es oficial', () => {
  process.env.PROSPECT_UNSUBSCRIBE_SECRET = 'qa-unsubscribe';
  const step = sequenceSteps('es')[0];
  const preview = renderSequenceMessage(step, { contact_name: 'María', name: 'Club Ejemplo', language: 'es' });
  assert.match(preview.body, /Hola, María:/);
  assert.match(preview.body, /Club Ejemplo/);
  assert.ok(preview.missingExperienceUrl);
  assert.match(preview.body, /\{\{experienceUrl\}\}/);
  const official = renderSequenceMessage(step, { contact_name: 'María', name: 'Club Ejemplo' }, { experienceUrl: 'https://padbol.com/experiencia-comercial?t=ok' });
  assert.equal(official.missingExperienceUrl, false);
  assert.match(official.body, /https:\/\/padbol\.com\/experiencia-comercial/);
  const local = renderSequenceMessage(step, {}, { experienceUrl: 'http://localhost:3000/experiencia-comercial' });
  assert.ok(local.missingExperienceUrl);
});

test('token de baja firmado y verificable', () => {
  process.env.PROSPECT_UNSUBSCRIBE_SECRET = 'qa-unsubscribe';
  const token = createUnsubscribeToken('prospect@example.com');
  assert.ok(token);
  assert.equal(verifyUnsubscribeToken(token)?.email, 'prospect@example.com');
  assert.equal(verifyUnsubscribeToken(`${token}x`), null);
});
