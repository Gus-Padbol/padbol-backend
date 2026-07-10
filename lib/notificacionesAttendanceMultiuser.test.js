import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { mapNotificationRow } from '../routes/notificaciones.js';
import {
  buildAttendanceNotificationDedupeKey,
  classifyAttendanceNotificationParticipant,
  notifyInitialAttendancePendingParticipants,
} from '../src/matches/matchAttendanceNotificationService.js';
import {
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  encodeNotificationLinkPayload,
  isEncodedNotificationLink,
} from '../utils/notificacionesMetadata.js';
import {
  createNotificacionIfAbsent,
  getNotificacionesMetadataStorageMode,
  listNotificacionesForUser,
  resetNotificacionesMetadataModeForTests,
} from '../utils/notificaciones.js';

const PARTIDO_ID = 53;
const CAP1 = '11111111-1111-1111-1111-111111111111';
const CAP2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const DEADLINE = '2026-07-13T21:00:00.000Z';

function buildMetadata(userId) {
  const dedupe = buildAttendanceNotificationDedupeKey(PARTIDO_ID, userId, 'initial');
  return {
    partido_id: PARTIDO_ID,
    deadline_at: DEADLINE,
    action: 'confirmar_asistencia',
    source: 'attendance_phase3',
    reminder_stage: null,
    dedupe_key: dedupe,
  };
}

function buildProdLikeStore() {
  const rows = [];
  let nextId = 1;

  return {
    rows,
    handler: {
      _filters: {},
      _selectCols: null,
      select(cols) {
        this._selectCols = cols;
        return this;
      },
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
                code: 'PGRST204',
                message: "Could not find the 'data' column of 'notificaciones' in the schema cache",
              },
            }),
          };
        }
        const row = { ...payload, id: nextId++ };
        rows.push(row);
        const self = {
          select(cols) {
            self._cols = cols;
            return self;
          },
          single: async () => {
            const cols = String(self._cols ?? '');
            if (cols === '*' || cols.includes('data')) {
              return {
                data: null,
                error: {
                  code: 'PGRST204',
                  message: "Could not find the 'data' column of 'notificaciones' in the schema cache",
                },
              };
            }
            return { data: row, error: null };
          },
        };
        return self;
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((candidate) => {
          for (const [key, value] of Object.entries(filters)) {
            if (key.endsWith('__contains')) return false;
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
      then(resolve) {
        const filters = { ...this._filters };
        this._filters = {};
        let matched = [...rows];
        if (filters.user_id) {
          matched = matched.filter((r) => r.user_id === filters.user_id);
        }
        resolve({ data: matched, error: null });
      },
    },
  };
}

function buildParticipantsStore(initial = []) {
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
      is(field, value) {
        this._filters[`${field}__is`] = value;
        return this;
      },
      update(payload) {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => {
            if (k.endsWith('__is')) {
              const field = k.replace('__is', '');
              return (r[field] ?? null) === v;
            }
            return String(r[k]) === String(v);
          }),
        );
        if (row) Object.assign(row, payload);
        return {
          select() { return this; },
          maybeSingle: async () => ({ data: row ?? null, error: null }),
        };
      },
    },
  };
}

function wrapSupabase(notifStore, participantsStore) {
  return {
    from(table) {
      if (table === 'notificaciones') return notifStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function pendingParticipant(userId, overrides = {}) {
  return {
    user_id: userId,
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    role: userId === CAP1 ? MATCH_PARTICIPANT_ROLES.ORGANIZER : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    attendance_requested_at: null,
    ...overrides,
  };
}

describe('classifyAttendanceNotificationParticipant', () => {
  it('organizador pending es candidato (regla vigente: recibe notificación)', () => {
    const result = classifyAttendanceNotificationParticipant(
      pendingParticipant(CAP1, { role: MATCH_PARTICIPANT_ROLES.ORGANIZER }),
    );
    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'candidate');
  });

  it('admin_validated se omite con not_pending', () => {
    const result = classifyAttendanceNotificationParticipant(
      pendingParticipant(CAP1, { attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED }),
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'not_pending');
  });
});

describe('notifyInitialAttendancePendingParticipants — multiusuario prod-like', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    resetNotificacionesMetadataModeForTests();
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('tres pending → tres notificaciones con fallback link tras PGRST204', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const notifStore = buildProdLikeStore();
    const participantsStore = buildParticipantsStore([
      pendingParticipant(CAP1),
      pendingParticipant(CAP2),
      pendingParticipant(P3),
    ]);
    const supabase = wrapSupabase(notifStore, participantsStore);

    const result = await notifyInitialAttendancePendingParticipants(supabase, PARTIDO_ID, {
      deadlineAt: DEADLINE,
      participants: participantsStore.rows,
    });

    assert.equal(result.notified, 3);
    assert.equal(result.errors, 0);
    assert.equal(notifStore.rows.length, 3);
    assert.equal(getNotificacionesMetadataStorageMode(), 'link');
    assert.equal(new Set(notifStore.rows.map((r) => r.user_id)).size, 3);
  });

  it('fallo en un participante no impide notificar a los siguientes', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const notifStore = buildProdLikeStore();
    const participantsStore = buildParticipantsStore([
      pendingParticipant(CAP1),
      pendingParticipant(CAP2),
      pendingParticipant(P3),
    ]);
    let calls = 0;
    const supabase = wrapSupabase(notifStore, participantsStore);

    const result = await notifyInitialAttendancePendingParticipants(supabase, PARTIDO_ID, {
      deadlineAt: DEADLINE,
      participants: participantsStore.rows,
      deps: {
        createNotificacionIfAbsent: async (client, payload) => {
          calls += 1;
          if (payload.user_id === CAP2) {
            return { created: false, duplicate: false, notificacion: null };
          }
          return createNotificacionIfAbsent(client, payload);
        },
      },
    });

    assert.equal(result.notified, 2);
    assert.equal(result.errors, 1);
    assert.equal(notifStore.rows.length, 2);
    assert.equal(calls, 3);
  });

  it('organizador admin_validated → skipped documentado', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const notifStore = buildProdLikeStore();
    const participantsStore = buildParticipantsStore([
      pendingParticipant(CAP1, { attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED }),
      pendingParticipant(P3),
    ]);
    const supabase = wrapSupabase(notifStore, participantsStore);

    const result = await notifyInitialAttendancePendingParticipants(supabase, PARTIDO_ID, {
      deadlineAt: DEADLINE,
      participants: participantsStore.rows,
    });

    assert.equal(result.notified, 1);
    assert.equal(result.skipped, 0);
    assert.ok(result.participant_outcomes.some((o) => o.user_id === CAP1 && o.reason === 'not_pending'));
    assert.equal(notifStore.rows[0].user_id, P3);
  });

  it('dedupe individual por user_id', async () => {
    const notifStore = buildProdLikeStore();
    const participantsStore = buildParticipantsStore([pendingParticipant(P3)]);
    const supabase = wrapSupabase(notifStore, participantsStore);
    const payload = {
      user_id: P3,
      tipo: 'asistencia_partido_pendiente',
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      data: buildMetadata(P3),
    };

    const first = await createNotificacionIfAbsent(supabase, payload);
    const second = await createNotificacionIfAbsent(supabase, payload);

    assert.equal(first.created, true);
    assert.equal(second.duplicate, true);
    assert.equal(notifStore.rows.length, 1);
  });

  it('attendance_requested_at solo tras persistencia correcta', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const notifStore = buildProdLikeStore();
    const participantsStore = buildParticipantsStore([pendingParticipant(P3)]);
    const supabase = wrapSupabase(notifStore, participantsStore);

    await notifyInitialAttendancePendingParticipants(supabase, PARTIDO_ID, {
      deadlineAt: DEADLINE,
      participants: participantsStore.rows,
      deps: {
        createNotificacionIfAbsent: async () => ({
          created: false,
          duplicate: false,
          notificacion: null,
        }),
      },
    });

    assert.equal(participantsStore.rows[0].attendance_requested_at, null);
  });
});

describe('GET /api/notificaciones — listado link-only', () => {
  afterEach(() => {
    resetNotificacionesMetadataModeForTests();
  });

  it('listNotificacionesForUser devuelve fila codificada en link', async () => {
    const notifStore = buildProdLikeStore();
    notifStore.rows.push({
      id: 24,
      user_id: CAP2,
      tipo: 'asistencia_partido_pendiente',
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      link: encodeNotificationLinkPayload(buildMetadata(CAP2)),
      leida: false,
      created_at: '2026-07-10T21:46:36.702Z',
    });
    const supabase = { from: () => notifStore.handler };

    const rows = await listNotificacionesForUser(supabase, CAP2);
    assert.equal(rows.length, 1);
    assert.ok(isEncodedNotificationLink(rows[0].link));
  });

  it('mapNotificationRow decodifica data y oculta link técnico', () => {
    const mapped = mapNotificationRow({
      id: 24,
      tipo: 'asistencia_partido_pendiente',
      titulo: 'Confirmá si jugaste',
      mensaje: 'mensaje',
      link: encodeNotificationLinkPayload(buildMetadata(CAP2)),
      leida: false,
      created_at: '2026-07-10T21:46:36.702Z',
    });

    assert.equal(mapped.data.partido_id, PARTIDO_ID);
    assert.equal(mapped.data.dedupe_key, buildAttendanceNotificationDedupeKey(PARTIDO_ID, CAP2, 'initial'));
    assert.equal(mapped.link, null);
    assert.equal(String(mapped.link ?? '').startsWith('padbol:notif:'), false);
  });

  it('GET filtra por usuario autenticado vía listNotificacionesForUser', async () => {
    const notifStore = buildProdLikeStore();
    for (const userId of [CAP1, CAP2, P3]) {
      notifStore.rows.push({
        id: notifStore.rows.length + 1,
        user_id: userId,
        tipo: 'asistencia_partido_pendiente',
        titulo: 'T',
        mensaje: 'M',
        link: encodeNotificationLinkPayload(buildMetadata(userId)),
        leida: false,
        created_at: '2026-07-10T21:46:36.702Z',
      });
    }
    const supabase = { from: () => notifStore.handler };

    const cap2Rows = await listNotificacionesForUser(supabase, CAP2);
    assert.equal(cap2Rows.length, 1);
    assert.equal(cap2Rows[0].user_id, CAP2);
  });
});
