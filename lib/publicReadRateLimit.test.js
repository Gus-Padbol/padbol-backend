import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesPublicReadRateLimitPath } from './rateLimit.js';

test('matches public profile and rankings paths', () => {
  assert.equal(matchesPublicReadRateLimitPath('/api/usuarios/perfil-publico/uuid'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/jugador/perfil-publico/uuid'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/jugadores/perfil-publico/uuid'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/rankings'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/rankings/padbol'), true);
});

test('matches sedes resenas, partidos, scoreboard, abiertos', () => {
  assert.equal(matchesPublicReadRateLimitPath('/api/sedes/1/resenas'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/sedes/1/reseñas'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/sedes/1/partidos'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/scoreboard/partidos'), true);
  assert.equal(matchesPublicReadRateLimitPath('/api/partidos/abiertos'), true);
});

test('does not match health, webhooks, or unrelated sedes GETs', () => {
  assert.equal(matchesPublicReadRateLimitPath('/health'), false);
  assert.equal(matchesPublicReadRateLimitPath('/api/webhooks/stripe'), false);
  assert.equal(matchesPublicReadRateLimitPath('/api/sedes'), false);
  assert.equal(matchesPublicReadRateLimitPath('/api/sedes/1'), false);
  assert.equal(matchesPublicReadRateLimitPath('/api/crear-pago-stripe'), false);
});
