import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClientErrorPayload,
  INTERNAL_SERVER_ERROR_MESSAGE,
  sanitizeClientErrorMessage,
} from './httpErrors.js';

test('production 500 returns generic message', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const payload = buildClientErrorPayload(new Error('column "foo" does not exist'), 500);
    assert.equal(payload.status, 500);
    assert.equal(payload.body.error, INTERNAL_SERVER_ERROR_MESSAGE);
    assert.equal(payload.body.ok, false);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('production 400 keeps useful validation message', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const message = sanitizeClientErrorMessage(new Error('sede_id inválido'), 400);
    assert.equal(message, 'sede_id inválido');
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('development 500 keeps err.message', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const message = sanitizeClientErrorMessage(new Error('debug detail'), 500);
    assert.equal(message, 'debug detail');
  } finally {
    process.env.NODE_ENV = prev;
  }
});
