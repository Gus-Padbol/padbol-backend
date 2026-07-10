import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  DEFAULT_MATCH_ATTENDANCE_FIRST_REMINDER_HOURS,
  DEFAULT_MATCH_ATTENDANCE_REMINDER_CRON_INTERVAL_MINUTES,
  getMatchAttendanceReminderCronExpression,
  isMatchAttendanceConfirmationEnabled,
  isMatchAttendanceRemindersEnabled,
} from '../src/matches/matchAttendanceConfig.js';
import { resetNotificacionesMetadataModeForTests } from '../utils/notificaciones.js';
import {
  ATTENDANCE_NOTIFICATION_MESSAGE,
  ATTENDANCE_NOTIFICATION_TITLE,
  ATTENDANCE_NOTIFICATION_TYPE,
  ATTENDANCE_REMINDER_24H_TITLE,
  buildAttendanceNotificationDedupeKey,
  notifyInitialAttendancePendingParticipants,
  processAttendanceReminders,
  resolveAttendanceReminderStage,
  sendAttendanceNotificationToParticipant,
} from '../src/matches/matchAttendanceNotificationService.js';
import { openAttendanceWindowForMatch } from '../src/matches/matchAttendanceService.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  initMatchAttendanceReminderCron,
  isMatchAttendanceReminderCronRunning,
  resetMatchAttendanceReminderCronForTests,
  runMatchAttendanceReminderCronJob,
  startMatchAttendanceReminderCron,
  stopMatchAttendanceReminderCron,
} from '../src/cron/matchAttendanceReminderCron.js';

const PARTIDO_ID = 91;
const CAPTAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const PLAYER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const OPENED_AT = '2026-07-08T12:00:00.000Z';
const DEADLINE_AT = '2026-07-11T12:00:00.000Z';

function buildNotificacionesStore(initial = []) {
  const rows = initial.map((row, index) => ({ id: `n-${index + 1}`, ...row }));
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
        const row = { ...payload, id: `n-${nextId++}` };
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
              const data = candidate[field] ?? {};
              for (const [k, v] of Object.entries(value)) {
                if (data[k] !== v) return false;
              }
              continue;
            }
            if (key.endsWith('__like')) {
              const field = key.replace('__like', '');
              const haystack = String(candidate[field] ?? '');
              const prefix = String(value).replace(/[%_]/g, '');
              if (!haystack.startsWith(prefix)) return false;
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
      order() { return this; },
      insert(payload) {
        const row = { ...payload, id: nextId++ };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
      },
      then(resolve) {
        let matched = [...rows];
        const filters = this._filters;
        if (filters.match_type != null) matched = matched.filter((r) => r.match_type === filters.match_type);
        if (filters.match_id != null) matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
        if (filters.user_id != null) matched = matched.filter((r) => r.user_id === filters.user_id);
        if (filters.attendance_status != null) {
          matched = matched.filter((r) => r.attendance_status === filters.attendance_status);
        }
        this._filters = {};
        resolve({ data: matched, error: null });
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((candidate) => {
          for (const [key, value] of Object.entries(filters)) {
            if (key.endsWith('__is')) {
              const field = key.replace('__is', '');
              if (value === null && candidate[field] != null) return false;
              continue;
            }
            if (String(candidate[key]) !== String(value)) return false;
          }
          return true;
        });
        return { data: row ?? null, error: null };
      },
      update(payload) {
        const filters = {};
        const builder = {
          eq(field, value) {
            filters[field] = value;
            return builder;
          },
          is(field, value) {
            filters[`${field}__is`] = value;
            return builder;
          },
          select() { return builder; },
          single: async () => {
            const row = rows.find((candidate) =>
              Object.entries(filters).every(([k, v]) => String(candidate[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: row ? null : { message: 'not found' } };
          },
          maybeSingle: async () => {
            const row = rows.find((candidate) => {
              for (const [key, value] of Object.entries(filters)) {
                if (key.endsWith('__is')) {
                  const field = key.replace('__is', '');
                  if (value === null && candidate[field] != null) return false;
                  continue;
                }
                if (String(candidate[key]) !== String(value)) return false;
              }
              return true;
            });
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: null };
          },
        };
        return builder;
      },
    },
  };
}

function buildPartidoStore(partido) {
  let row = { ...partido };
  return {
    get row() { return row; },
    handler: {
      _filters: {},
      _updatePayload: null,
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      is(field, value) {
        this._filters[`${field}__is`] = value;
        return this;
      },
      lte() { return this; },
      order() { return this; },
      limit() { return this; },
      update(payload) {
        this._updatePayload = payload;
        return this;
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const updatePayload = this._updatePayload;
        this._updatePayload = null;
        if (updatePayload) {
          const match = Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
          if (match) row = { ...row, ...updatePayload };
          return { data: match ? { ...row } : null, error: null };
        }
        const match = Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
        return { data: match ? { ...row } : null, error: null };
      },
      then(resolve) {
        resolve({ data: [row], error: null });
      },
    },
  };
}

function createPhase35Mock({
  partido,
  participants = [],
  notificaciones = [],
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidoStore = buildPartidoStore(partido);
  const notificacionesStore = buildNotificacionesStore(notificaciones);

  return {
    participantsStore,
    partidoStore,
    notificacionesStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'notificaciones') return notificacionesStore.handler;
      if (table === 'partidos_abiertos_jugadores' || table === 'push_tokens' || table === 'jugadores_perfil') {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
          then: async (resolve) => resolve({ data: [], error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function pendingParticipant(userId, overrides = {}) {
  return {
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    user_id: userId,
    role: userId === CAPTAIN_ID ? MATCH_PARTICIPANT_ROLES.ORGANIZER : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    attendance_requested_at: null,
    ...overrides,
  };
}

function openPartido(overrides = {}) {
  return {
    id: PARTIDO_ID,
    sede_id: 2,
    capitan_user_id: CAPTAIN_ID,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 1 },
    partido_torneo_id: null,
    torneo_id: null,
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
    attendance_opened_at: null,
    attendance_deadline_at: null,
    attendance_resolved_at: null,
    attendance_resolution_reason: null,
    rewards_processed_at: null,
    ...overrides,
  };
}

describe('matchAttendance Fase 3.5 — configuración', () => {
  const originalReminders = process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
  const originalConfirm = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalReminders == null) delete process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
    else process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = originalReminders;
    if (originalConfirm == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalConfirm;
  });

  it('recordatorios apagados por defecto', () => {
    delete process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    assert.equal(isMatchAttendanceRemindersEnabled(), false);
    assert.equal(isMatchAttendanceConfirmationEnabled(), false);
    assert.equal(
      getMatchAttendanceReminderCronExpression(),
      `*/${DEFAULT_MATCH_ATTENDANCE_REMINDER_CRON_INTERVAL_MINUTES} * * * *`,
    );
    assert.equal(DEFAULT_MATCH_ATTENDANCE_FIRST_REMINDER_HOURS, 24);
  });
});

describe('matchAttendance Fase 3.5 — dedupe y textos', () => {
  it('genera clave estable por etapa', () => {
    const key = buildAttendanceNotificationDedupeKey(PARTIDO_ID, PLAYER_ID, 'reminder_24h');
    assert.equal(key, `attendance|match|${PARTIDO_ID}|user|${PLAYER_ID}|reminder_24h`);
    assert.equal(ATTENDANCE_NOTIFICATION_TITLE, 'Confirmá si jugaste');
    assert.match(ATTENDANCE_NOTIFICATION_MESSAGE, /Confirmá tu asistencia/);
    assert.equal(ATTENDANCE_NOTIFICATION_TYPE, 'asistencia_partido_pendiente');
  });

  it('resolveAttendanceReminderStage respeta 24h y 48h', () => {
    const opened = new Date('2026-07-08T12:00:00.000Z');
    assert.equal(
      resolveAttendanceReminderStage(opened, new Date('2026-07-09T10:00:00.000Z')),
      null,
    );
    assert.equal(
      resolveAttendanceReminderStage(opened, new Date('2026-07-09T13:00:00.000Z')),
      'reminder_24h',
    );
    assert.equal(
      resolveAttendanceReminderStage(opened, new Date('2026-07-10T13:00:00.000Z')),
      'reminder_48h',
    );
  });
});

describe('matchAttendance Fase 3.5 — notificación inicial', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    resetNotificacionesMetadataModeForTests();
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('flag confirmación OFF → sin notificación', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const mock = createPhase35Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID)],
    });
    const result = await notifyInitialAttendancePendingParticipants(mock, PARTIDO_ID, {
      deadlineAt: DEADLINE_AT,
      participants: mock.participantsStore.rows,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.notified, 0);
  });

  it('apertura con pending → notificación inicial y requested_at', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase35Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID)],
    });

    let pushCalls = 0;
    const result = await notifyInitialAttendancePendingParticipants(mock, PARTIDO_ID, {
      deadlineAt: DEADLINE_AT,
      partido: mock.partidoStore.row,
      participants: mock.participantsStore.rows,
      deps: {
        sendPushToUser: async () => {
          pushCalls += 1;
          return { ok: true };
        },
      },
    });

    assert.equal(result.notified, 1);
    assert.equal(pushCalls, 1);
    assert.equal(mock.notificacionesStore.rows.length, 1);
    assert.equal(mock.notificacionesStore.rows[0].tipo, ATTENDANCE_NOTIFICATION_TYPE);
    assert.equal(mock.notificacionesStore.rows[0].data.action, 'confirmar_asistencia');
    assert.equal(mock.participantsStore.rows[0].attendance_requested_at != null, true);
    assert.equal(mock.participantsStore.rows[0].reward_status, MATCH_REWARD_STATUS.PENDING);
  });

  it('participante resuelto y sin user_id → skip', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase35Mock({
      partido: openPartido(),
      participants: [
        pendingParticipant(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        pendingParticipant(null, { user_id: null }),
      ],
    });

    const result = await notifyInitialAttendancePendingParticipants(mock, PARTIDO_ID, {
      deadlineAt: DEADLINE_AT,
      participants: mock.participantsStore.rows,
    });

    assert.equal(result.notified, 0);
    assert.equal(result.skipped, 0);
  });

  it('attendance_requested_at existente → no duplica', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase35Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID, { attendance_requested_at: OPENED_AT })],
    });

    let pushCalls = 0;
    const result = await notifyInitialAttendancePendingParticipants(mock, PARTIDO_ID, {
      deadlineAt: DEADLINE_AT,
      participants: mock.participantsStore.rows,
      deps: {
        sendPushToUser: async () => {
          pushCalls += 1;
          return { ok: true };
        },
      },
    });

    assert.equal(result.notified, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(pushCalls, 0);
    assert.equal(mock.notificacionesStore.rows.length, 0);
  });

  it('fallo push → apertura/notificación interna no duplica', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const dedupeKey = buildAttendanceNotificationDedupeKey(PARTIDO_ID, PLAYER_ID, 'initial');
    const mock = createPhase35Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID)],
      notificaciones: [{
        user_id: PLAYER_ID,
        tipo: ATTENDANCE_NOTIFICATION_TYPE,
        data: { dedupe_key: dedupeKey },
      }],
    });
    mock.participantsStore.rows[0].attendance_requested_at = OPENED_AT;

    const result = await sendAttendanceNotificationToParticipant(mock, {
      matchId: PARTIDO_ID,
      participant: mock.participantsStore.rows[0],
      deadlineAt: DEADLINE_AT,
      stage: 'initial',
      deps: {
        sendPushToUser: async () => {
          throw new Error('push down');
        },
      },
    });

    assert.equal(result.duplicate, true);
    assert.equal(mock.notificacionesStore.rows.length, 1);
    assert.equal(result.ok, true);
  });

  it('torneo → skip', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const result = await notifyInitialAttendancePendingParticipants(
      createPhase35Mock({ partido: openPartido({ partido_torneo_id: 9 }) }),
      PARTIDO_ID,
      { deadlineAt: DEADLINE_AT, partido: { partido_torneo_id: 9 } },
    );
    assert.equal(result.reason, 'torneo_out_of_scope');
  });
});

describe('matchAttendance Fase 3.5 — recordatorios', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
  const originalReminders = process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
    if (originalReminders == null) delete process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
    else process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = originalReminders;
  });

  it('recordatorio 24h y dedupe', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = 'true';
    const mock = createPhase35Mock({
      partido: {
        id: PARTIDO_ID,
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        attendance_opened_at: '2026-07-08T12:00:00.000Z',
        attendance_deadline_at: DEADLINE_AT,
        partido_torneo_id: null,
        torneo_id: null,
        estado: 'finalizado',
      },
      participants: [pendingParticipant(PLAYER_ID)],
    });

    const now = new Date('2026-07-09T14:00:00.000Z');
    const summary = await processAttendanceReminders(mock, {
      now,
      batchSize: 10,
      deps: { sendPushToUser: async () => ({ ok: true }) },
    });

    assert.equal(summary.sent, 1);
    assert.equal(mock.notificacionesStore.rows[0].titulo, ATTENDANCE_REMINDER_24H_TITLE);
  });

  it('antes de 24h → no envía', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = 'true';
    const mock = createPhase35Mock({
      partido: {
        id: PARTIDO_ID,
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        attendance_opened_at: '2026-07-08T12:00:00.000Z',
        attendance_deadline_at: DEADLINE_AT,
        partido_torneo_id: null,
        torneo_id: null,
        estado: 'finalizado',
      },
      participants: [pendingParticipant(PLAYER_ID)],
    });

    const summary = await processAttendanceReminders(mock, {
      now: new Date('2026-07-08T20:00:00.000Z'),
      batchSize: 10,
      deps: { sendPushToUser: async () => ({ ok: true }) },
    });

    assert.equal(summary.sent, 0);
  });

  it('después de deadline → no envía', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = 'true';
    const mock = createPhase35Mock({
      partido: {
        id: PARTIDO_ID,
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        attendance_opened_at: '2026-07-08T12:00:00.000Z',
        attendance_deadline_at: '2026-07-09T12:00:00.000Z',
        partido_torneo_id: null,
        torneo_id: null,
        estado: 'finalizado',
      },
      participants: [pendingParticipant(PLAYER_ID)],
    });

    const summary = await processAttendanceReminders(mock, {
      now: new Date('2026-07-10T12:00:00.000Z'),
      batchSize: 10,
    });

    assert.equal(summary.sent, 0);
  });

  it('segunda ejecución cron → no duplica', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = 'true';
    const dedupeKey = buildAttendanceNotificationDedupeKey(PARTIDO_ID, PLAYER_ID, 'reminder_24h');
    const mock = createPhase35Mock({
      partido: {
        id: PARTIDO_ID,
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        attendance_opened_at: '2026-07-08T12:00:00.000Z',
        attendance_deadline_at: DEADLINE_AT,
        partido_torneo_id: null,
        torneo_id: null,
        estado: 'finalizado',
      },
      participants: [pendingParticipant(PLAYER_ID)],
      notificaciones: [{
        user_id: PLAYER_ID,
        tipo: ATTENDANCE_NOTIFICATION_TYPE,
        data: { dedupe_key: dedupeKey },
      }],
    });

    const summary = await processAttendanceReminders(mock, {
      now: new Date('2026-07-09T14:00:00.000Z'),
      batchSize: 10,
    });

    assert.equal(summary.sent, 0);
    assert.equal(summary.duplicates, 1);
  });
});

describe('matchAttendance Fase 3.5 — cron recordatorios', () => {
  const originalReminders = process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;

  afterEach(() => {
    stopMatchAttendanceReminderCron();
    resetMatchAttendanceReminderCronForTests();
    if (originalReminders == null) delete process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
    else process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = originalReminders;
  });

  it('cron OFF no inicia timer', () => {
    delete process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
    const result = startMatchAttendanceReminderCron({
      supabaseAdmin: {},
      cron: { schedule() { return { stop() {} }; } },
    });
    assert.equal(result.started, false);
    assert.equal(isMatchAttendanceReminderCronRunning(), false);
  });

  it('timer no se duplica y stop limpia', () => {
    process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED = 'true';
    let scheduled = 0;
    const fakeCron = {
      schedule() {
        scheduled += 1;
        return { stop() {} };
      },
    };
    const first = startMatchAttendanceReminderCron({ supabaseAdmin: {}, cron: fakeCron });
    const second = startMatchAttendanceReminderCron({ supabaseAdmin: {}, cron: fakeCron });
    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(scheduled, 1);
    assert.equal(stopMatchAttendanceReminderCron().stopped, true);
    assert.equal(isMatchAttendanceReminderCronRunning(), false);
  });

  it('runMatchAttendanceReminderCronJob respeta reminders_disabled', async () => {
    delete process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
    const result = await runMatchAttendanceReminderCronJob({ supabaseAdmin: {} });
    assert.equal(result.reason, 'reminders_disabled');
  });

  it('initMatchAttendanceReminderCron delega en start', () => {
    delete process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED;
    const result = initMatchAttendanceReminderCron({
      supabaseAdmin: {},
      cron: { schedule() { return { stop() {} }; } },
    });
    assert.equal(result.started, false);
  });
});

describe('matchAttendance Fase 3.5 — integración apertura', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    resetNotificacionesMetadataModeForTests();
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('fallo push no impide abrir ventana', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase35Mock({
      partido: openPartido(),
      participants: [],
    });

    mock.from = ((originalFrom) => (table) => {
      if (table === 'partidos_abiertos_jugadores') {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          then(resolve) {
            resolve({
              data: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID, email: 'p@test.com' }],
              error: null,
            });
          },
        };
      }
      return originalFrom(table);
    })(mock.from.bind(mock));

    const result = await openAttendanceWindowForMatch(mock, PARTIDO_ID, {
      now: new Date(OPENED_AT),
      partido: openPartido(),
      hasClearResult: true,
      deps: {
        attendanceNotifications: {
          sendPushToUser: async () => {
            throw new Error('push failed');
          },
        },
      },
    });

    assert.equal(result.opened, true);
    assert.equal(result.notifications?.notified >= 0, true);
  });
});
