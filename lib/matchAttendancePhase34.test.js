import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  DEFAULT_MATCH_ATTENDANCE_CRON_BATCH_SIZE,
  DEFAULT_MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES,
  getMatchAttendanceCronBatchSize,
  getMatchAttendanceCronExpression,
  getMatchAttendanceCronIntervalMinutes,
  isMatchAttendanceConfirmationEnabled,
  isMatchAttendanceCronEnabled,
} from '../src/matches/matchAttendanceConfig.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_RESOLUTION_REASON,
  MATCH_ATTENDANCE_RESPONSE_SOURCE,
  MATCH_ATTENDANCE_STATUS,
  MATCH_PARTICIPANT_ROLES,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import {
  computeAttendanceCollectionTransitionAfterTimeout,
  expireAttendanceWindow,
  fetchExpiredOpenAttendanceWindows,
  processExpiredAttendanceWindows,
} from '../src/matches/matchAttendanceService.js';
import {
  initMatchAttendanceCron,
  isMatchAttendanceCronRunning,
  resetMatchAttendanceCronForTests,
  runMatchAttendanceCronJob,
  startMatchAttendanceCron,
  stopMatchAttendanceCron,
} from '../src/cron/matchAttendanceCron.js';

const PARTIDO_ID = 90;
const SEDE_ID = 2;
const CAPTAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const PLAYER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const OPENED_AT = '2026-07-08T12:00:00.000Z';
const DEADLINE_AT = '2026-07-09T12:00:00.000Z';
const NOW = '2026-07-10T12:00:00.000Z';

function buildParticipantsStore(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, ...row }));

  return {
    rows,
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      order() { return this; },
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
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
      update(payload) {
        const filters = {};
        const builder = {
          eq(field, value) {
            filters[field] = value;
            return builder;
          },
          select() { return builder; },
          maybeSingle: async () => {
            const matched = rows.filter((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            for (const row of matched) Object.assign(row, payload);
            return { data: matched[0] ?? null, error: null };
          },
          then(resolve) {
            const matched = rows.filter((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            for (const row of matched) Object.assign(row, payload);
            resolve({ data: matched, error: null });
          },
        };
        return builder;
      },
    },
  };
}

function buildPartidoStore(initial) {
  let rows = Array.isArray(initial) ? initial.map((row) => ({ ...row })) : [{ ...initial }];

  return {
    get row() { return rows[0]; },
    get rows() { return rows; },
    setRows(next) { rows = next.map((row) => ({ ...row })); },
    handler: {
      _filters: {},
      _updatePayload: null,
      _limit: null,
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      is(field, value) {
        this._filters[`${field}__is`] = value;
        return this;
      },
      lte(field, value) {
        this._filters[`${field}__lte`] = value;
        return this;
      },
      order() { return this; },
      limit(n) {
        this._limit = n;
        return this;
      },
      update(payload) {
        this._updatePayload = payload;
        return this;
      },
      maybeSingle: async function maybeSingle() {
        const matched = this._matchRows();
        const updatePayload = this._updatePayload;
        this._resetQuery();
        if (updatePayload && matched.length === 1) {
          rows = rows.map((row) => (row.id === matched[0].id ? { ...row, ...updatePayload } : row));
          return { data: { ...rows.find((r) => r.id === matched[0].id) }, error: null };
        }
        return { data: matched[0] ?? null, error: null };
      },
      then(resolve) {
        resolve({ data: this._matchRows(), error: null });
      },
      _matchRows() {
        const filters = { ...this._filters };
        const limit = this._limit;
        const updatePayload = this._updatePayload;
        this._resetQuery();

        let matched = rows.filter((row) => {
          for (const [key, value] of Object.entries(filters)) {
            if (key.endsWith('__is')) {
              const field = key.replace('__is', '');
              if (value === null && row[field] != null) return false;
              continue;
            }
            if (key.endsWith('__lte')) {
              const field = key.replace('__lte', '');
              const rowValue = row[field];
              if (rowValue == null || String(rowValue) > String(value)) return false;
              continue;
            }
            if (String(row[key]) !== String(value)) return false;
          }
          return true;
        });

        if (updatePayload) {
          matched = matched.map((row) => {
            const updated = { ...row, ...updatePayload };
            rows = rows.map((r) => (r.id === row.id ? updated : r));
            return updated;
          });
        }

        if (limit != null) matched = matched.slice(0, limit);
        return matched;
      },
      _resetQuery() {
        this._filters = {};
        this._limit = null;
        this._updatePayload = null;
      },
    },
  };
}

function createPhase34Mock({ partido, participants = [], partidosList = null } = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidoStore = buildPartidoStore(partidosList ?? partido);

  return {
    participantsStore,
    partidoStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'reservas' || table === 'scoreboard_partidos') {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return this; },
          limit() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function openExpiredPartido(overrides = {}) {
  return {
    id: PARTIDO_ID,
    sede_id: SEDE_ID,
    capitan_user_id: CAPTAIN_ID,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 1 },
    deporte: 'padbol',
    reserva_id: null,
    partido_torneo_id: null,
    torneo_id: null,
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    attendance_opened_at: OPENED_AT,
    attendance_deadline_at: DEADLINE_AT,
    attendance_resolved_at: null,
    attendance_resolution_reason: null,
    rewards_processed_at: null,
    ...overrides,
  };
}

function participantRow(userId, overrides = {}) {
  return {
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    user_id: userId,
    role: userId === CAPTAIN_ID ? MATCH_PARTICIPANT_ROLES.ORGANIZER : MATCH_PARTICIPANT_ROLES.PARTICIPANT,
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    attendance_requested_at: OPENED_AT,
    attendance_responded_at: null,
    attendance_response_source: null,
    attendance_denial_reason: null,
    ...overrides,
  };
}

describe('matchAttendance Fase 3.4 — configuración cron', () => {
  const originalCron = process.env.MATCH_ATTENDANCE_CRON_ENABLED;
  const originalInterval = process.env.MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES;
  const originalBatch = process.env.MATCH_ATTENDANCE_CRON_BATCH_SIZE;
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalCron == null) delete process.env.MATCH_ATTENDANCE_CRON_ENABLED;
    else process.env.MATCH_ATTENDANCE_CRON_ENABLED = originalCron;
    if (originalInterval == null) delete process.env.MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES;
    else process.env.MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES = originalInterval;
    if (originalBatch == null) delete process.env.MATCH_ATTENDANCE_CRON_BATCH_SIZE;
    else process.env.MATCH_ATTENDANCE_CRON_BATCH_SIZE = originalBatch;
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('cron apagado por defecto', () => {
    delete process.env.MATCH_ATTENDANCE_CRON_ENABLED;
    assert.equal(isMatchAttendanceCronEnabled(), false);
    assert.equal(getMatchAttendanceCronIntervalMinutes(), DEFAULT_MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES);
    assert.equal(getMatchAttendanceCronBatchSize(), DEFAULT_MATCH_ATTENDANCE_CRON_BATCH_SIZE);
  });

  it('cron flag true reconocido', () => {
    process.env.MATCH_ATTENDANCE_CRON_ENABLED = 'true';
    assert.equal(isMatchAttendanceCronEnabled(), true);
    process.env.MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES = '30';
    assert.equal(getMatchAttendanceCronExpression(), '*/30 * * * *');
  });
});

describe('matchAttendance Fase 3.4 — transición timeout', () => {
  it('vencida con elegibles → ready timeout_partial', () => {
    const transition = computeAttendanceCollectionTransitionAfterTimeout([
      { user_id: CAPTAIN_ID, attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED },
      { user_id: PLAYER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.EXCLUDED },
    ]);
    assert.equal(transition.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.READY);
    assert.equal(transition.resolution_reason, MATCH_ATTENDANCE_RESOLUTION_REASON.TIMEOUT_PARTIAL);
  });

  it('vencida sin elegibles → blocked', () => {
    const transition = computeAttendanceCollectionTransitionAfterTimeout([
      { user_id: PLAYER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.DENIED },
      { user_id: OTHER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.EXCLUDED },
    ]);
    assert.equal(transition.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED);
    assert.equal(transition.resolution_reason, MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS);
  });
});

describe('matchAttendance Fase 3.4 — expireAttendanceWindow', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('ventana no vencida → skip', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partido: openExpiredPartido({ attendance_deadline_at: '2026-07-12T12:00:00.000Z' }),
      participants: [participantRow(PLAYER_ID)],
    });

    const result = await expireAttendanceWindow(mock, PARTIDO_ID, { now: new Date(NOW) });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_expired');
  });

  it('open vencida excluye pending con system_timeout', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partido: openExpiredPartido(),
      participants: [
        participantRow(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        participantRow(PLAYER_ID),
      ],
    });

    const result = await expireAttendanceWindow(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        tryFinalizeMatchAttendanceRewards: async () => ({
          credited: false,
          rewards: { processed: false, padcoins: { ok: false }, ranking: { ok: false } },
        }),
      },
    });

    assert.equal(result.expired, true);
    assert.equal(result.pending_excluded, 1);
    const pendingRow = mock.participantsStore.rows.find((r) => r.user_id === PLAYER_ID);
    assert.equal(pendingRow.attendance_status, MATCH_ATTENDANCE_STATUS.EXCLUDED);
    assert.equal(pendingRow.attendance_response_source, MATCH_ATTENDANCE_RESPONSE_SOURCE.SYSTEM_TIMEOUT);
    assert.equal(pendingRow.reward_status, MATCH_REWARD_STATUS.PENDING);
  });

  it('preserva confirmed/denied/admin_validated/excluded', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partido: openExpiredPartido(),
      participants: [
        participantRow(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        participantRow(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.DENIED }),
        participantRow(OTHER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED }),
      ],
    });

    await expireAttendanceWindow(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: { tryFinalizeMatchAttendanceRewards: async () => ({ credited: false, rewards: {} }) },
    });

    assert.equal(
      mock.participantsStore.rows.find((r) => r.user_id === CAPTAIN_ID).attendance_status,
      MATCH_ATTENDANCE_STATUS.CONFIRMED,
    );
    assert.equal(
      mock.participantsStore.rows.find((r) => r.user_id === PLAYER_ID).attendance_status,
      MATCH_ATTENDANCE_STATUS.DENIED,
    );
    assert.equal(
      mock.participantsStore.rows.find((r) => r.user_id === OTHER_ID).attendance_status,
      MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
    );
  });

  it('ready dispara tryFinalize y credited en éxito', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partido: openExpiredPartido(),
      participants: [
        participantRow(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        participantRow(PLAYER_ID),
      ],
    });

    let finalizeCalls = 0;
    const result = await expireAttendanceWindow(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        tryFinalizeMatchAttendanceRewards: async (supabase, matchId) => {
          finalizeCalls += 1;
          await supabase.from('partidos_abiertos')
            .update({
              attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
              rewards_processed_at: NOW,
            })
            .eq('id', matchId)
            .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.READY);
          return {
            credited: true,
            rewards: { processed: true, padcoins: { ok: true }, ranking: { ok: true } },
          };
        },
      },
    });

    assert.equal(finalizeCalls, 1);
    assert.equal(result.credited, true);
    assert.equal(result.rewards.processed, true);
    assert.equal(
      mock.partidoStore.row.attendance_collection_status,
      MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
    );
  });

  it('fallo parcial finalize → sigue ready', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partido: openExpiredPartido(),
      participants: [participantRow(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED })],
    });

    const result = await expireAttendanceWindow(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: {
        tryFinalizeMatchAttendanceRewards: async () => ({
          credited: false,
          rewards: { processed: false, padcoins: { ok: false, reason: 'padcoins_failed' }, ranking: { ok: true } },
        }),
      },
    });

    assert.equal(result.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.READY);
    assert.equal(result.credited, false);
  });

  it('sin elegibles → blocked', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partido: openExpiredPartido(),
      participants: [
        participantRow(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.DENIED }),
        participantRow(PLAYER_ID),
      ],
    });

    const result = await expireAttendanceWindow(mock, PARTIDO_ID, { now: new Date(NOW) });
    assert.equal(result.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED);
    assert.equal(result.resolution_reason, MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS);
  });

  it('segunda ejecución no duplica exclusiones', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partido: openExpiredPartido(),
      participants: [participantRow(CAPTAIN_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED })],
    });

    await expireAttendanceWindow(mock, PARTIDO_ID, {
      now: new Date(NOW),
      deps: { tryFinalizeMatchAttendanceRewards: async () => ({ credited: false, rewards: {} }) },
    });

    mock.partidoStore.row.attendance_collection_status = MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN;
    const second = await expireAttendanceWindow(mock, PARTIDO_ID, { now: new Date(NOW) });
    assert.equal(second.pending_excluded, 0);
  });

  it('torneo y cancelado → skip', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const torneo = await expireAttendanceWindow(
      createPhase34Mock({ partido: openExpiredPartido({ partido_torneo_id: 1 }) }),
      PARTIDO_ID,
      { now: new Date(NOW) },
    );
    assert.equal(torneo.reason, 'torneo_out_of_scope');

    const cancelado = await expireAttendanceWindow(
      createPhase34Mock({ partido: openExpiredPartido({ estado: 'cancelado' }) }),
      PARTIDO_ID,
      { now: new Date(NOW) },
    );
    assert.equal(cancelado.reason, 'partido_cancelado');
  });

  it('feature flag OFF → skip', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const result = await expireAttendanceWindow(
      createPhase34Mock({ partido: openExpiredPartido(), participants: [participantRow(PLAYER_ID)] }),
      PARTIDO_ID,
      { now: new Date(NOW) },
    );
    assert.equal(result.reason, 'feature_disabled');
    assert.equal(isMatchAttendanceConfirmationEnabled(), false);
  });
});

describe('matchAttendance Fase 3.4 — processExpiredAttendanceWindows', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('lote continúa ante error individual', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase34Mock({
      partidosList: [
        openExpiredPartido({ id: 1 }),
        openExpiredPartido({ id: 2 }),
      ],
      participants: [
        participantRow(CAPTAIN_ID, { match_id: '1', attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        participantRow(CAPTAIN_ID, { match_id: '2', attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
      ],
    });

    let calls = 0;
    const summary = await processExpiredAttendanceWindows(mock, {
      now: new Date(NOW),
      batchSize: 10,
      deps: {
        tryFinalizeMatchAttendanceRewards: async (_supabase, matchId) => {
          calls += 1;
          if (Number(matchId) === 1) throw new Error('boom');
          return { credited: false, rewards: { processed: false } };
        },
      },
    });

    assert.equal(summary.examined, 2);
    assert.equal(summary.errors, 1);
    assert.equal(summary.expired, 1);
    assert.equal(calls, 2);
  });
});

describe('matchAttendance Fase 3.4 — cron timer', () => {
  const originalCron = process.env.MATCH_ATTENDANCE_CRON_ENABLED;

  afterEach(() => {
    stopMatchAttendanceCron();
    resetMatchAttendanceCronForTests();
    if (originalCron == null) delete process.env.MATCH_ATTENDANCE_CRON_ENABLED;
    else process.env.MATCH_ATTENDANCE_CRON_ENABLED = originalCron;
  });

  it('cron OFF no inicia timer', () => {
    delete process.env.MATCH_ATTENDANCE_CRON_ENABLED;
    const fakeCron = { schedule() { return { stop() {} }; } };
    const result = startMatchAttendanceCron({ supabaseAdmin: {}, cron: fakeCron });
    assert.equal(result.started, false);
    assert.equal(isMatchAttendanceCronRunning(), false);
  });

  it('timer no se duplica y stop limpia', () => {
    process.env.MATCH_ATTENDANCE_CRON_ENABLED = 'true';
    let scheduled = 0;
    const fakeCron = {
      schedule() {
        scheduled += 1;
        return { stop() {} };
      },
    };

    const first = startMatchAttendanceCron({ supabaseAdmin: {}, cron: fakeCron });
    const second = startMatchAttendanceCron({ supabaseAdmin: {}, cron: fakeCron });
    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(scheduled, 1);
    assert.equal(isMatchAttendanceCronRunning(), true);

    const stopped = stopMatchAttendanceCron();
    assert.equal(stopped.stopped, true);
    assert.equal(isMatchAttendanceCronRunning(), false);
  });

  it('runMatchAttendanceCronJob respeta cron_disabled', async () => {
    delete process.env.MATCH_ATTENDANCE_CRON_ENABLED;
    const result = await runMatchAttendanceCronJob({ supabaseAdmin: {} });
    assert.equal(result.reason, 'cron_disabled');
  });

  it('initMatchAttendanceCron delega en start', () => {
    delete process.env.MATCH_ATTENDANCE_CRON_ENABLED;
    const result = initMatchAttendanceCron({ supabaseAdmin: {}, cron: { schedule() { return { stop() {} }; } } });
    assert.equal(result.started, false);
  });
});

describe('matchAttendance Fase 3.4 — fetchExpiredOpenAttendanceWindows', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('flag OFF → lista vacía', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const mock = createPhase34Mock({ partidosList: [openExpiredPartido()] });
    const rows = await fetchExpiredOpenAttendanceWindows(mock, { now: new Date(NOW) });
    assert.equal(rows.length, 0);
  });
});
