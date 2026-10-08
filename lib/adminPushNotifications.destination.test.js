import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAdminPushDestinationData,
  parseAdminPushDestination,
  validateAdminPushDestination,
} from './adminPushNotifications.js';

test('rechaza destinos vacíos, externos o con separadores inseguros', () => {
  assert.throws(() => parseAdminPushDestination(), (error) => error?.code === 'ADMIN_PUSH_DESTINATION_REQUIRED');
  assert.throws(() => parseAdminPushDestination({ type: 'url', entityId: 'https://evil.test' }), /no permitido/);
  assert.throws(() => parseAdminPushDestination({ type: 'inscripcion', registrationId: '../admin' }), /válido/);
});

test('inscripción QA genera el deep link canónico móvil y fallback DEV', async () => {
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        eq(_column, id) { this.id = id; return this; },
        maybeSingle() {
          return Promise.resolve({
            data: table === 'ng_inscripciones' && this.id === '994b43f2-4281-4a3f-bce7-90d833fe06bc'
              ? { id: this.id, sesion_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
              : null,
            error: null,
          });
        },
      };
    },
  };
  const destination = await validateAdminPushDestination(supabase, {
    type: 'inscripcion', registrationId: '994b43f2-4281-4a3f-bce7-90d833fe06bc',
  });
  assert.equal(destination.deepLink,
    'padbolmatch://next-generation/inscripcion/994b43f2-4281-4a3f-bce7-90d833fe06bc?session_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(destination.webDeepLink,
    'https://dev.padbol.com/next-generation/jornada?session_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&registration_id=994b43f2-4281-4a3f-bce7-90d833fe06bc');
  assert.equal(buildAdminPushDestinationData(destination).registrationId, destination.entityId);
});
