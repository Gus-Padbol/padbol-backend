import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountFreeEnrollmentRoute } from './freeEnrollment.js';

test('confirmation rejects coerced identifiers before database access', async t => {
  let connections = 0;
  const app = express();
  app.use(express.json());
  mountFreeEnrollmentRoute(app, {
    getAuthenticatedUser: async req => req.headers.authorization ? { user: { id: 'fixture' } } : { status: 401 },
    pool: { connect: async () => { connections++; throw Object.assign(new Error('fixture database reached'), { status: 503 }); } },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = async (body, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/torneos/confirmar-inscripcion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'fixture' } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  for (const field of ['torneo_id', 'equipo_id']) {
    for (const value of [true, false, [1], [], {}, null, '', ' ', '0x1', '1e0', '+1', '01', '1.0', ' 1 ', 0, -1, 1.5, '9007199254740993']) {
      const response = await send({ torneo_id: 1, equipo_id: 1, [field]: value });
      assert.equal(response.status, 400, JSON.stringify({ field, value }));
      assert.equal(response.body.code, 'ENROLLMENT_INVALID');
    }
  }
  assert.equal(connections, 0);
  assert.equal((await send({ torneo_id: 1, equipo_id: 1 }, false)).status, 401);
  for (const value of [1, '1']) assert.equal((await send({ torneo_id: value, equipo_id: value })).status, 503);
  assert.equal(connections, 2, 'valid integer IDs reach the unchanged confirmation helper');
});
