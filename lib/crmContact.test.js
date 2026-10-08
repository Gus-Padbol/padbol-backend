import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CRM_CHANNELS,
  attemptIdFor,
  matchCrmContact,
  normalizeEmail,
  normalizePhone,
  resolveChannelAttempt,
} from './crmContact.js';

test('normaliza email (lowercase, gmail puntos y +alias)', () => {
  assert.equal(normalizeEmail('  MaIdAnA.RD20@Gmail.com '), 'maidanard20@gmail.com');
  assert.equal(normalizeEmail('maidana+club@googlemail.com'), 'maidana@googlemail.com');
  assert.equal(normalizeEmail('   '), null);
  assert.equal(normalizeEmail('sin-arroba'), null);
});

test('normaliza teléfono (solo dígitos, quita 00 y prefijo)', () => {
  assert.equal(normalizePhone('+54 9 11 2345 6789'), '5491123456789');
  assert.equal(normalizePhone('(011) 2345-6789'), '01123456789');
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('123'), null); // demasiado corto
});

test('agrupa por email o teléfono normalizado, nunca por nombre', () => {
  const existing = [
    { id: 'c1', email_normalized: 'maidana.rd20@gmail.com', phone_normalized: null, nombre: 'Rodrigo' },
    { id: 'c2', email_normalized: null, phone_normalized: '5491123456789', nombre: 'Otra persona' },
  ];
  assert.equal(matchCrmContact({ email: 'maidana.rd20@gmail.com', existing }).status, 'exact');
  assert.equal(matchCrmContact({ phone: '+54 9 11 2345 6789', existing }).status, 'exact');
  assert.equal(matchCrmContact({ nombre: 'Rodrigo Maidana', existing }).status, 'none');
});

test('coincidencia ambigua no fusiona y marca revisión', () => {
  const existing = [
    { id: 'c1', email_normalized: 'm@gmail.com', phone_normalized: '5491111111111' },
    { id: 'c2', email_normalized: 'otro@x.com', phone_normalized: '5491111111111' },
  ];
  const result = matchCrmContact({ phone: '5491111111111', existing });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.contacts.length, 2);
});

test('exclusión de canal: WhatsApp elegido impide correo en el mismo intento', () => {
  const attemptId = attemptIdFor({ source: 'form', sourceId: 's1', contactKey: 'k1' });
  const first = resolveChannelAttempt({ attemptId, channel: 'whatsapp' });
  assert.equal(first.status, 'accepted');

  const email = resolveChannelAttempt({
    attemptId,
    channel: 'email',
    existingAttempts: [{ attempt_id: attemptId, channel: 'whatsapp' }],
  });
  assert.equal(email.status, 'blocked');
});

test('exclusión de canal: correo elegido impide WhatsApp en el mismo intento', () => {
  const attemptId = attemptIdFor({ source: 'form', sourceId: 's2', contactKey: 'k2' });
  assert.equal(resolveChannelAttempt({ attemptId, channel: 'email' }).status, 'accepted');
  const wa = resolveChannelAttempt({
    attemptId,
    channel: 'whatsapp',
    existingAttempts: [{ attempt_id: attemptId, channel: 'email' }],
  });
  assert.equal(wa.status, 'blocked');
});

test('un intento posterior por otro canal sí se acepta', () => {
  const first = attemptIdFor({ source: 'form', sourceId: 's3', contactKey: 'k3' });
  const later = attemptIdFor({ source: 'form', sourceId: 's4', contactKey: 'k3' });
  resolveChannelAttempt({ attemptId: first, channel: 'whatsapp' });
  const second = resolveChannelAttempt({
    attemptId: later,
    channel: 'email',
    existingAttempts: [{ attempt_id: first, channel: 'whatsapp' }],
  });
  assert.equal(second.status, 'accepted');
});

test('reintentos y webhooks duplicados son idempotentes', () => {
  const attemptId = attemptIdFor({ source: 'webhook', sourceId: 'w1', contactKey: 'k4' });
  assert.equal(resolveChannelAttempt({ attemptId, channel: 'whatsapp' }).status, 'accepted');
  const replay = resolveChannelAttempt({
    attemptId,
    channel: 'whatsapp',
    existingAttempts: [{ attempt_id: attemptId, channel: 'whatsapp' }],
  });
  assert.equal(replay.status, 'idempotent');
});

test('canal inválido o intento sin id se rechaza', () => {
  assert.equal(resolveChannelAttempt({ attemptId: 'x', channel: 'sms' }).status, 'invalid');
  assert.equal(resolveChannelAttempt({ channel: 'email' }).status, 'invalid');
  assert.ok(CRM_CHANNELS.includes('whatsapp') && CRM_CHANNELS.includes('email'));
});
