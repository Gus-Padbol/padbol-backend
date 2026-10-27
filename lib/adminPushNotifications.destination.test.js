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

test('restored compositor screens and academy produce trusted links and valid secure payloads', async () => {
  const { sanitizePushData } = await import('./mobilePushNotifications.js');
  for (const entityId of ['inicio', 'notificaciones', 'torneos', 'rankings', 'jugar', 'perfil', 'clases']) {
    const destination = await validateAdminPushDestination(null, { type: 'pantalla', entityId });
    const payload = sanitizePushData(buildAdminPushDestinationData(destination));
    assert.equal(payload.type, 'admin_message');
    assert.equal(payload.deepLink, destination.deepLink);
  }
  const academy = await validateAdminPushDestination(null, { type: 'academy', entityId: '' });
  assert.equal(sanitizePushData(buildAdminPushDestinationData(academy)).deepLink, 'https://dev.padbol.com/academy/mi-academy');
  assert.throws(() => parseAdminPushDestination({ type: 'pantalla', entityId: 'https://evil.test' }), /no permitida/);
  assert.throws(() => sanitizePushData({ type: 'admin_message', deepLink: 'https://evil.test' }), /no permitido/);
});

test('restored match and next generation destinations retain concrete entity navigation', async () => {
  const { sanitizePushData } = await import('./mobilePushNotifications.js');
  const supabase = { from(table) { return { select() { return this; }, eq(_key, id) { this.id=id; return this; }, async maybeSingle() { return {data: table === 'partidos' ? {id:this.id,torneo_id:42} : {id:this.id},error:null}; } }; } };
  const match = await validateAdminPushDestination(supabase, {type:'partido',entityId:'21'});
  const matchData = sanitizePushData(buildAdminPushDestinationData(match));
  assert.equal(matchData.route,'PartidoDetalle');
  assert.equal(matchData.params.partidoId,'21');
  assert.equal(matchData.webDeepLink,'/torneo/42?partido=21');
  const session = await validateAdminPushDestination(supabase, {type:'next_generation',entityId:'session-21'});
  assert.equal(sanitizePushData(buildAdminPushDestinationData(session)).deepLink,'https://dev.padbol.com/next-generation/jornada?session_id=session-21');
});
