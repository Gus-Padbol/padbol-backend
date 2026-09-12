import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWhatsappRecipient } from './whatsappCloud.js';

test('describeWhatsappRecipient distingue 13 vs 14 dígitos sin exponer el número', () => {
  const a = describeWhatsappRecipient('5492216280711');   // 13 dígitos
  const b = describeWhatsappRecipient('54221156280711');  // 14 dígitos

  assert.equal(a.digitCount, 13);
  assert.equal(b.digitCount, 14);
  assert.equal(a.last4, '0711');
  assert.equal(b.last4, '0711');
  assert.notEqual(a.hash, b.hash);

  // La máscara conserva la longitud y los últimos 4, y nunca contiene el número completo.
  assert.equal(a.masked.length, 13);
  assert.equal(b.masked.length, 14);
  assert.ok(a.masked.endsWith('0711'));
  assert.ok(b.masked.endsWith('0711'));
  assert.ok(!a.masked.includes('5492216280711'));
  assert.ok(!b.masked.includes('54221156280711'));
  assert.ok(!JSON.stringify(a).includes('5492216280711'));
  assert.ok(!JSON.stringify(b).includes('54221156280711'));
});

test('describeWhatsappRecipient maneja valores cortos sin filtrar nada', () => {
  const short = describeWhatsappRecipient('123');
  assert.equal(short.digitCount, 3);
  assert.equal(short.last4, '123');
  assert.equal(short.masked, '•••');
  assert.ok(short.hash.length === 64);
});
