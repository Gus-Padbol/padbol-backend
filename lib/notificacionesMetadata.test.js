import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  LEGACY_NOTIFICATION_LINK_PREFIX,
  MAX_NOTIFICATION_ENCODED_LINK_LENGTH,
  NOTIFICATION_LINK_PREFIX,
  buildDedupeLinkPrefix,
  decodeNotificationLinkPayload,
  encodeNotificationLinkPayload,
  isEncodedNotificationLink,
  isMissingNotificacionesDataColumnError,
  resolveNotificationData,
  resolveNotificationPayload,
} from '../utils/notificacionesMetadata.js';
import {
  createNotificacion,
  createNotificacionIfAbsent,
  findNotificacionByDedupeKey,
  getNotificacionesMetadataStorageMode,
  resetNotificacionesMetadataModeForTests,
} from '../utils/notificaciones.js';
import {
  ATTENDANCE_NOTIFICATION_ACTION,
  ATTENDANCE_NOTIFICATION_SOURCE,
  ATTENDANCE_NOTIFICATION_TYPE,
  buildAttendanceNotificationDedupeKey,
  buildAttendanceNotificationData,
  sendAttendanceNotificationToParticipant,
} from '../src/matches/matchAttendanceNotificationService.js';
import { MATCH_ATTENDANCE_STATUS, MATCH_REWARD_STATUS } from '../src/matches/matchParticipantsConstants.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const PARTIDO_ID = 44;
const DEADLINE = '2026-07-13T20:00:00.000Z';
const REAL_LINK = '/partidos/44/asistencia';

function buildMetadata(dedupeKey, extra = {}) {
  return {
    ...buildAttendanceNotificationData(PARTIDO_ID, { deadlineAt: DEADLINE }),
    dedupe_key: dedupeKey,
    ...extra,
  };
}

function mapNotificationRowLikeApi(row) {
  const { data, link } = resolveNotificationPayload(row);
  return {
    id: row.id,
    tipo: row.tipo,
    titulo: row.titulo ?? null,
    mensaje: row.mensaje,
    data,
    link,
    leida: Boolean(row.leida),
    created_at: row.created_at,
  };
}

function wrapStore(store) {
  return {
    from(table) {
      if (table === 'notificaciones') return store.handler;
      if (table === 'match_participants') {
        return {
          update() { return this; },
          eq() { return this; },
          is() { return this; },
          select() { return this; },
          maybeSingle: async () => ({ data: { id: 1 }, error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function buildNotificacionesStoreProdLike(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, ...row }));
  let nextId = rows.length + 1;

  return {
    rows,
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      contains(field, value) {
        this._filters[`${field}__contains`] = value;
        return this;
      },
      like(field, pattern) {
        this._filters[`${field}__like`] = pattern;
        return this;
      },
      order() { return this; },
      limit() { return this; },
      insert(payload) {
        if (Object.prototype.hasOwnProperty.call(payload, 'data')) {
          return {
            select() { return this; },
            single: async () => ({
              data: null,
              error: {
                code: '42703',
                message: "Could not find the 'data' column of 'notificaciones' in the schema cache",
              },
            }),
          };
        }
        const row = { ...payload, id: nextId++ };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((candidate) => {
          for (const [key, value] of Object.entries(filters)) {
            if (key.endsWith('__contains')) {
              return false;
            }
            if (key.endsWith('__like')) {
              const field = key.replace('__like', '');
              const prefix = String(value).replace(/[%_\\]/g, '');
              if (!String(candidate[field] ?? '').startsWith(prefix)) return false;
              continue;
            }
            if (String(candidate[key]) !== String(value)) return false;
          }
          return true;
        });
        return { data: row ?? null, error: null };
      },
    },
  };
}

function buildNotificacionesStoreWithData(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, ...row }));
  let nextId = rows.length + 1;

  return {
    rows,
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      contains(field, value) {
        this._filters[`${field}__contains`] = value;
        return this;
      },
      like(field, pattern) {
        this._filters[`${field}__like`] = pattern;
        return this;
      },
      order() { return this; },
      limit() { return this; },
      insert(payload) {
        const row = { ...payload, id: nextId++ };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((candidate) => {
          for (const [key, value] of Object.entries(filters)) {
            if (key.endsWith('__contains')) {
              const field = key.replace('__contains', '');
              const expected = value?.dedupe_key;
              if (candidate[field]?.dedupe_key !== expected) return false;
              continue;
            }
            if (key.endsWith('__like')) {
              const field = key.replace('__like', '');
              const prefix = String(value).replace(/[%_\\]/g, '');
              if (!String(candidate[field] ?? '').startsWith(prefix)) return false;
              continue;
            }
            if (String(candidate[key]) !== String(value)) return false;
          }
          return true;
        });
        return { data: row ?? null, error: null };
      },
    },
  };
}

describe('notificacionesMetadata', () => {
  it('encode/decode roundtrip conserva metadata de asistencia', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const metadata = buildMetadata(dedupe);
    const encoded = encodeNotificationLinkPayload(metadata);
    const decoded = decodeNotificationLinkPayload(encoded);
    assert.equal(decoded.dedupe_key, dedupe);
    assert.equal(decoded.partido_id, PARTIDO_ID);
    assert.equal(decoded.action, ATTENDANCE_NOTIFICATION_ACTION);
    assert.equal(decoded.source, ATTENDANCE_NOTIFICATION_SOURCE);
    assert.equal(decoded.deadline_at, DEADLINE);
  });

  it('encode preserva original_link dentro del payload', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const metadata = buildMetadata(dedupe, { original_link: REAL_LINK });
    const encoded = encodeNotificationLinkPayload(metadata);
    const decoded = decodeNotificationLinkPayload(encoded);
    assert.equal(decoded.original_link, REAL_LINK);
  });

  it('resolveNotificationPayload expone data y link público', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const metadata = buildMetadata(dedupe, { original_link: REAL_LINK });
    const encoded = encodeNotificationLinkPayload(metadata);
    const resolved = resolveNotificationPayload({ link: encoded });

    assert.equal(resolved.data.partido_id, PARTIDO_ID);
    assert.equal(resolved.data.dedupe_key, dedupe);
    assert.equal(resolved.link, REAL_LINK);
    assert.equal(resolved.data.original_link, undefined);
  });

  it('resolveNotificationPayload prioriza columna data y link real', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const metadata = buildMetadata(dedupe);
    const resolved = resolveNotificationPayload({
      data: metadata,
      link: REAL_LINK,
    });
    assert.deepEqual(resolved.data, metadata);
    assert.equal(resolved.link, REAL_LINK);
  });

  it('resolveNotificationData prioriza data y cae a link codificado', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const metadata = buildMetadata(dedupe);
    assert.deepEqual(resolveNotificationData({ data: metadata }), metadata);
    assert.deepEqual(
      resolveNotificationData({ link: encodeNotificationLinkPayload(metadata) }),
      metadata,
    );
  });

  it('detecta error 42703 de columna data', () => {
    assert.equal(
      isMissingNotificacionesDataColumnError({
        code: '42703',
        message: "Could not find the 'data' column of 'notificaciones' in the schema cache",
      }),
      true,
    );
  });

  it('buildDedupeLinkPrefix usa hash seguro sin caracteres LIKE', () => {
    const key = 'attendance|match|1|user|u|reminder_%|_24h';
    const prefix = buildDedupeLinkPrefix(key);
    assert.ok(prefix.startsWith(NOTIFICATION_LINK_PREFIX));
    assert.equal(prefix.includes('%'), false);
    assert.equal(prefix.includes('_'), false);
    assert.equal(prefix.includes('|'), false);
    assert.equal(prefix.includes(key), false);
  });

  it('dedupe key con %, _ y | no altera LIKE', async () => {
    const dedupe = 'attendance|match|1|user|u|reminder_%|_24h';
    const store = buildNotificacionesStoreProdLike([{
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'T',
      mensaje: 'M',
      link: encodeNotificationLinkPayload(buildMetadata(dedupe)),
      leida: false,
    }]);

    resetNotificacionesMetadataModeForTests();
    const found = await findNotificacionByDedupeKey(wrapStore(store), USER_ID, dedupe);
    assert.ok(found);
  });

  it('prefijo corrupto no produce crash', () => {
    const resolved = resolveNotificationPayload({ link: 'padbol:notif:v1h:deadbeef:not-json' });
    assert.deepEqual(resolved.data, {});
    assert.equal(resolved.link, null);
  });

  it('link legacy sin prefijo se conserva', () => {
    const resolved = resolveNotificationPayload({ link: REAL_LINK });
    assert.deepEqual(resolved.data, {});
    assert.equal(resolved.link, REAL_LINK);
  });

  it('formato legacy v1 sigue decodificando', () => {
    const dedupe = 'attendance|match|9|user|u|initial';
    const restEnc = Buffer.from(JSON.stringify({ partido_id: 9 })).toString('base64url');
    const legacyLink = `${LEGACY_NOTIFICATION_LINK_PREFIX}${dedupe}:${restEnc}`;
    const decoded = decodeNotificationLinkPayload(legacyLink);
    assert.equal(decoded.dedupe_key, dedupe);
    assert.equal(decoded.partido_id, 9);
  });

  it('payload demasiado grande se rechaza de forma controlada', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    assert.throws(
      () => encodeNotificationLinkPayload(
        buildMetadata(dedupe, { blob: 'x'.repeat(5000) }),
        { maxLength: 256 },
      ),
      (err) => err.code === 'NOTIFICATION_LINK_TOO_LARGE',
    );
  });

  it('sanitize elimina campos sensibles', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const encoded = encodeNotificationLinkPayload(buildMetadata(dedupe, {
      token: 'secret-token',
      email: 'a@b.com',
      telefono: '+54911',
    }));
    const decoded = decodeNotificationLinkPayload(encoded);
    assert.equal(decoded.token, undefined);
    assert.equal(decoded.email, undefined);
    assert.equal(decoded.telefono, undefined);
  });

  it('isEncodedNotificationLink distingue link técnico de real', () => {
    assert.equal(isEncodedNotificationLink(`${NOTIFICATION_LINK_PREFIX}abc:payload`), true);
    assert.equal(isEncodedNotificationLink(REAL_LINK), false);
  });
});

describe('notificaciones — schema prod link sin data', () => {
  afterEach(() => {
    resetNotificacionesMetadataModeForTests();
  });

  it('createNotificacion persiste metadata en link cuando falta data', async () => {
    const store = buildNotificacionesStoreProdLike();
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const row = await createNotificacion(wrapStore(store), {
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      data: buildMetadata(dedupe),
    });

    assert.ok(row);
    assert.equal(row.data, undefined);
    assert.ok(isEncodedNotificationLink(row.link));
    assert.equal(getNotificacionesMetadataStorageMode(), 'link');
  });

  it('createNotificacion con metadata y link real preserva original_link', async () => {
    const store = buildNotificacionesStoreProdLike();
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const row = await createNotificacion(wrapStore(store), {
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      link: REAL_LINK,
      data: buildMetadata(dedupe),
    });

    assert.ok(row);
    assert.ok(isEncodedNotificationLink(row.link));
    const decoded = decodeNotificationLinkPayload(row.link);
    assert.equal(decoded.original_link, REAL_LINK);
  });

  it('createNotificacion sin metadata conserva link sin codificar', async () => {
    const store = buildNotificacionesStoreProdLike();
    const row = await createNotificacion(wrapStore(store), {
      user_id: USER_ID,
      tipo: 'sistema',
      titulo: 'Aviso',
      mensaje: 'mensaje',
      link: REAL_LINK,
    });

    assert.ok(row);
    assert.equal(row.link, REAL_LINK);
    assert.equal(isEncodedNotificationLink(row.link), false);
  });

  it('findNotificacionByDedupeKey encuentra fila por link codificado', async () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const store = buildNotificacionesStoreProdLike([{
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'T',
      mensaje: 'M',
      link: encodeNotificationLinkPayload(buildMetadata(dedupe)),
      leida: false,
    }]);

    resetNotificacionesMetadataModeForTests();
    const found = await findNotificacionByDedupeKey(wrapStore(store), USER_ID, dedupe);
    assert.ok(found);
    assert.ok(isEncodedNotificationLink(found.link));
  });

  it('createNotificacionIfAbsent dedupe inicial sin duplicar', async () => {
    const store = buildNotificacionesStoreProdLike();
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const payload = {
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      data: buildMetadata(dedupe),
    };

    const first = await createNotificacionIfAbsent(wrapStore(store), payload);
    const second = await createNotificacionIfAbsent(wrapStore(store), payload);

    assert.equal(first.created, true);
    assert.equal(second.duplicate, true);
    assert.equal(store.rows.length, 1);
  });

  it('dedupe recordatorio 24h y 48h son independientes', async () => {
    const store = buildNotificacionesStoreProdLike();
    const key24 = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'reminder_24h');
    const key48 = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'reminder_48h');

    await createNotificacionIfAbsent(wrapStore(store), {
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'R24',
      mensaje: 'm',
      data: buildMetadata(key24),
    });
    const second = await createNotificacionIfAbsent(wrapStore(store), {
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'R48',
      mensaje: 'm',
      data: buildMetadata(key48),
    });

    assert.equal(second.created, true);
    assert.equal(store.rows.length, 2);
  });

  it('GET devuelve data correcta y link original, nunca link técnico', () => {
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const metadata = buildMetadata(dedupe, { original_link: REAL_LINK });
    const mapped = mapNotificationRowLikeApi({
      id: 1,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      link: encodeNotificationLinkPayload(metadata),
      leida: false,
      created_at: '2026-07-10T20:00:00.000Z',
    });

    assert.equal(mapped.data.partido_id, PARTIDO_ID);
    assert.equal(mapped.data.action, ATTENDANCE_NOTIFICATION_ACTION);
    assert.equal(mapped.data.dedupe_key, dedupe);
    assert.equal(mapped.link, REAL_LINK);
    assert.equal(String(mapped.link).startsWith('padbol:notif:'), false);
  });

  it('GET con link legacy sin metadata devuelve link tal cual', () => {
    const mapped = mapNotificationRowLikeApi({
      id: 2,
      tipo: 'sistema',
      titulo: 'Aviso',
      mensaje: 'mensaje',
      link: REAL_LINK,
      leida: false,
      created_at: '2026-07-10T20:00:00.000Z',
    });

    assert.deepEqual(mapped.data, {});
    assert.equal(mapped.link, REAL_LINK);
  });

  it('payload demasiado grande no crea notificación', async () => {
    const store = buildNotificacionesStoreProdLike();
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const row = await createNotificacion(wrapStore(store), {
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      data: buildMetadata(dedupe, { blob: 'x'.repeat(5000) }),
    });

    assert.equal(row, null);
    assert.equal(store.rows.length, 0);
  });

  it('push falla pero notificación interna persiste', async () => {
    const store = buildNotificacionesStoreProdLike();
    const participant = {
      id: 1,
      user_id: USER_ID,
      attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
      reward_status: MATCH_REWARD_STATUS.PENDING,
      attendance_requested_at: null,
    };

    const result = await sendAttendanceNotificationToParticipant(wrapStore(store), {
      matchId: PARTIDO_ID,
      participant,
      deadlineAt: DEADLINE,
      stage: 'initial',
      deps: {
        sendPushToUser: async () => {
          throw new Error('push down');
        },
      },
    });

    assert.equal(result.sent, true);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].tipo, ATTENDANCE_NOTIFICATION_TYPE);
    assert.ok(store.rows[0].link);
  });
});

describe('notificaciones — schema con columna data', () => {
  afterEach(() => {
    resetNotificacionesMetadataModeForTests();
  });

  it('createNotificacion persiste data y link por separado', async () => {
    const store = buildNotificacionesStoreWithData();
    const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, USER_ID, 'initial');
    const row = await createNotificacion(wrapStore(store), {
      user_id: USER_ID,
      tipo: ATTENDANCE_NOTIFICATION_TYPE,
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      link: REAL_LINK,
      data: buildMetadata(dedupe),
    });

    assert.ok(row.data);
    assert.equal(row.link, REAL_LINK);
    assert.equal(getNotificacionesMetadataStorageMode(), 'data');

    const mapped = mapNotificationRowLikeApi(row);
    assert.equal(mapped.data.dedupe_key, dedupe);
    assert.equal(mapped.link, REAL_LINK);
    assert.equal(isEncodedNotificationLink(mapped.link), false);
  });
});
