import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { createPartidosRouter } from '../routes/partidos.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_RESOLUTION_REASON,
  MATCH_ATTENDANCE_STATUS,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
  ATTENDANCE_DENIAL_REASON_MAX_LENGTH,
} from '../src/matches/matchParticipantsConstants.js';
import {
  computeNextAttendanceCollectionTransition,
  evaluateAttendanceCollectionState,
  isSamePlayerAttendanceResponse,
  normalizeAttendanceDenialReason,
  parsePlayerAttendanceResponseBody,
  submitPlayerAttendanceResponse,
  validatePlayerAttendanceSubmission,
} from '../src/matches/matchAttendanceService.js';

const PARTIDO_ID = 88;
const SEDE_ID = 2;
const CAPTAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const PLAYER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const OPENED_AT = '2026-07-10T12:00:00.000Z';
const DEADLINE_AT = '2026-07-13T12:00:00.000Z';
const NOW = '2026-07-11T12:00:00.000Z';

const STATS_COLUMN_ERROR = {
  code: '42703',
  message: 'column "attendance_requested_at" does not exist',
};

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
      order() { return this; },
      then(resolve) {
        let matched = [...rows];
        const filters = this._filters;
        if (filters.match_type != null) matched = matched.filter((r) => r.match_type === filters.match_type);
        if (filters.match_id != null) matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
        if (filters.user_id != null) matched = matched.filter((r) => r.user_id === filters.user_id);
        if (filters.id != null) matched = matched.filter((r) => String(r.id) === String(filters.id));
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
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: null };
          },
          single: async () => {
            const row = rows.find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
            );
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: row ? null : { message: 'not found' } };
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
    },
  };
}

function buildJugadoresStore(rows = []) {
  return {
    handler: {
      _filters: {},
      select() { return this; },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
    },
  };
}

function createPhase32Mock({
  partido,
  participants = [],
  jugadores = [],
  missingParticipantColumns = false,
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidoStore = buildPartidoStore(partido);
  const jugadoresStore = buildJugadoresStore(jugadores);

  return {
    participantsStore,
    partidoStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'partidos_abiertos_jugadores') return jugadoresStore.handler;
      if (table === 'match_participants') {
        if (missingParticipantColumns) {
          return {
            select(cols) {
              this._cols = cols;
              return this;
            },
            eq() { return this; },
            order() { return this; },
            maybeSingle: async () => {
              if (String(this._cols ?? '').includes('attendance_requested_at')) {
                return { data: null, error: STATS_COLUMN_ERROR };
              }
              return participantsStore.handler.maybeSingle.call(participantsStore.handler);
            },
            update() {
              return {
                eq() { return this; },
                select() { return this; },
                maybeSingle: async () => ({ data: null, error: STATS_COLUMN_ERROR }),
              };
            },
            then(resolve) {
              if (String(this._cols ?? '').includes('attendance_requested_at')) {
                resolve({ data: null, error: STATS_COLUMN_ERROR });
                return;
              }
              participantsStore.handler.then(resolve);
            },
          };
        }
        return participantsStore.handler;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function openPartido(overrides = {}) {
  return {
    id: PARTIDO_ID,
    sede_id: SEDE_ID,
    capitan_user_id: CAPTAIN_ID,
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    attendance_opened_at: OPENED_AT,
    attendance_deadline_at: DEADLINE_AT,
    attendance_resolved_at: null,
    attendance_resolution_reason: null,
    rewards_processed_at: null,
    ...overrides,
  };
}

function pendingParticipant(userId, overrides = {}) {
  return {
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    user_id: userId,
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    attendance_requested_at: OPENED_AT,
    attendance_responded_at: null,
    attendance_response_source: null,
    attendance_denial_reason: null,
    ...overrides,
  };
}

describe('matchAttendance Fase 3.2 — parsing y validación', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('reason vacío → null y reason largo limitado', () => {
    assert.equal(normalizeAttendanceDenialReason(''), null);
    assert.equal(normalizeAttendanceDenialReason('  '), null);
    const long = 'x'.repeat(ATTENDANCE_DENIAL_REASON_MAX_LENGTH + 50);
    assert.equal(normalizeAttendanceDenialReason(long).length, ATTENDANCE_DENIAL_REASON_MAX_LENGTH);
  });

  it('parse body inválido', () => {
    assert.equal(parsePlayerAttendanceResponseBody({ response: 'maybe' }).ok, false);
  });

  it('flag OFF → 409', () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const result = validatePlayerAttendanceSubmission({
      featureEnabled: false,
      schemaAvailable: true,
      collectionStatus: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
      deadlineAt: DEADLINE_AT,
      participant: { id: 1 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 409);
    assert.equal(result.reason, 'feature_disabled');
  });

  it('ventana none/expired/deadline → 409', () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    for (const status of [
      MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
      MATCH_ATTENDANCE_COLLECTION_STATUS.EXPIRED,
    ]) {
      const result = validatePlayerAttendanceSubmission({
        featureEnabled: true,
        schemaAvailable: true,
        collectionStatus: status,
        deadlineAt: DEADLINE_AT,
        participant: { id: 1 },
      });
      assert.equal(result.httpStatus, 409);
    }

    const expiredDeadline = validatePlayerAttendanceSubmission({
      featureEnabled: true,
      schemaAvailable: true,
      collectionStatus: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
      deadlineAt: '2026-07-01T00:00:00.000Z',
      participant: { id: 1 },
      now: new Date(NOW),
    });
    assert.equal(expiredDeadline.reason, 'deadline_expired');
  });

  it('admin_validated y excluded no modificables', () => {
    for (const status of [
      MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      MATCH_ATTENDANCE_STATUS.EXCLUDED,
    ]) {
      const result = validatePlayerAttendanceSubmission({
        featureEnabled: true,
        schemaAvailable: true,
        collectionStatus: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
        deadlineAt: DEADLINE_AT,
        participant: { id: 1, attendance_status: status },
        now: new Date(NOW),
      });
      assert.equal(result.httpStatus, 409);
      assert.equal(result.reason, 'status_locked');
    }
  });
});

describe('matchAttendance Fase 3.2 — transiciones agregadas', () => {
  it('pending restantes → open', () => {
    const next = computeNextAttendanceCollectionTransition([
      { user_id: PLAYER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED },
      { user_id: OTHER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.PENDING },
    ]);
    assert.equal(next.shouldTransition, false);
    assert.equal(next.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
  });

  it('último pending responde → ready', () => {
    const next = computeNextAttendanceCollectionTransition([
      { user_id: PLAYER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED },
      { user_id: OTHER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED },
    ]);
    assert.equal(next.shouldTransition, true);
    assert.equal(next.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.READY);
    assert.equal(next.resolution_reason, MATCH_ATTENDANCE_RESOLUTION_REASON.ALL_RESPONDED);
  });

  it('todos denied/excluded → blocked', () => {
    const next = computeNextAttendanceCollectionTransition([
      { user_id: PLAYER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.DENIED },
      { user_id: OTHER_ID, attendance_status: MATCH_ATTENDANCE_STATUS.EXCLUDED },
    ]);
    assert.equal(next.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED);
    assert.equal(next.resolution_reason, MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS);
  });
});

describe('matchAttendance Fase 3.2 — submitPlayerAttendanceResponse', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('usuario ajeno → 403', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });
    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      OTHER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.httpStatus, 403);
  });

  it('sin fila match_participants → 404', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });
    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.httpStatus, 404);
  });

  it('pending → confirmed', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID), pendingParticipant(OTHER_ID)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );

    assert.equal(result.ok, true);
    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.CONFIRMED);
    assert.equal(result.player.attendance_response_source, 'player');
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
    assert.equal(result.summary.pending, 1);
    const row = supabase.participantsStore.rows.find((r) => r.user_id === PLAYER_ID);
    assert.equal(row.reward_status, MATCH_REWARD_STATUS.PENDING);
  });

  it('pending → denied con reason', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID), pendingParticipant(OTHER_ID)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'deny', reason: '  no pude ir  ' },
      { now: new Date(NOW) },
    );

    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.DENIED);
    assert.equal(result.player.attendance_denial_reason, 'no pude ir');
    assert.equal(
      supabase.participantsStore.rows.find((r) => r.user_id === PLAYER_ID).reward_status,
      MATCH_REWARD_STATUS.PENDING,
    );
  });

  it('confirm repetido idempotente', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const respondedAt = NOW;
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID, {
        attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
        attendance_confirmed_at: respondedAt,
        attendance_responded_at: respondedAt,
        attendance_response_source: 'player',
      })],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date('2026-07-12T12:00:00.000Z') },
    );

    assert.equal(result.idempotent, true);
    const row = supabase.participantsStore.rows.find((r) => r.user_id === PLAYER_ID);
    assert.equal(row.attendance_responded_at, respondedAt);
  });

  it('confirmed → denied antes de cierre', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID, {
        attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
        attendance_confirmed_at: NOW,
        attendance_responded_at: NOW,
        attendance_response_source: 'player',
      }), pendingParticipant(OTHER_ID)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'deny', reason: 'me confundí' },
      { now: new Date(NOW) },
    );

    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.DENIED);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
  });

  it('denied → confirmed antes de cierre', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID, {
        attendance_status: MATCH_ATTENDANCE_STATUS.DENIED,
        attendance_responded_at: NOW,
        attendance_response_source: 'player',
        attendance_denial_reason: 'no',
      }), pendingParticipant(OTHER_ID)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );

    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.CONFIRMED);
    assert.equal(result.player.attendance_denial_reason, null);
  });

  it('último pending responde y pasa a ready', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [
        pendingParticipant(PLAYER_ID, {
          attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED,
          attendance_response_source: 'player',
        }),
        pendingParticipant(OTHER_ID),
      ],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: OTHER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      OTHER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );

    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.READY);
    assert.equal(result.match.resolution_reason, MATCH_ATTENDANCE_RESOLUTION_REASON.ALL_RESPONDED);
    assert.equal(supabase.partidoStore.row.attendance_collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.READY);
  });

  it('todos denied → blocked', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [
        pendingParticipant(PLAYER_ID, {
          attendance_status: MATCH_ATTENDANCE_STATUS.DENIED,
          attendance_response_source: 'player',
        }),
        pendingParticipant(OTHER_ID),
      ],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: OTHER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      OTHER_ID,
      { response: 'deny' },
      { now: new Date(NOW) },
    );

    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED);
    assert.equal(
      result.match.resolution_reason,
      MATCH_ATTENDANCE_RESOLUTION_REASON.NO_ELIGIBLE_PARTICIPANTS,
    );
  });

  it('schema faltante → 503 sin escritura parcial', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
      missingParticipantColumns: true,
    });

    const before = supabase.participantsStore.rows.length;
    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );

    assert.equal(result.httpStatus, 503);
    assert.equal(supabase.participantsStore.rows.length, before);
  });

  it('admin_validated no modificable → 409', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID, {
        attendance_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      })],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );

    assert.equal(result.httpStatus, 409);
    assert.equal(result.reason, 'status_locked');
  });

  it('flag OFF → 409 en submit', async () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    const supabase = createPhase32Mock({
      partido: openPartido(),
      participants: [pendingParticipant(PLAYER_ID)],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID }],
    });

    const result = await submitPlayerAttendanceResponse(
      supabase,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );

    assert.equal(result.httpStatus, 409);
    assert.equal(result.reason, 'feature_disabled');
  });

  it('isSamePlayerAttendanceResponse detecta deny repetido', () => {
    const participant = {
      attendance_status: MATCH_ATTENDANCE_STATUS.DENIED,
      attendance_response_source: 'player',
      attendance_denial_reason: 'viaje',
    };
    assert.equal(
      isSamePlayerAttendanceResponse(participant, MATCH_ATTENDANCE_STATUS.DENIED, 'viaje'),
      true,
    );
    assert.equal(
      isSamePlayerAttendanceResponse(participant, MATCH_ATTENDANCE_STATUS.DENIED, 'otro'),
      false,
    );
  });
});

describe('matchAttendance Fase 3.2 — evaluateAttendanceCollectionState', () => {
  it('no cambia si no es open', async () => {
    const supabase = createPhase32Mock({
      partido: openPartido({ attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY }),
      participants: [pendingParticipant(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED })],
    });
    const result = await evaluateAttendanceCollectionState(supabase, PARTIDO_ID);
    assert.equal(result.changed, false);
  });
});

describe('matchAttendance Fase 3.2 — routes', () => {
  it('registra POST /:id/asistencia', () => {
    const router = createPartidosRouter({
      supabase: {},
      supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
      getAuthenticatedUser: async () => ({ user: null, status: 401, error: 'auth' }),
      pgPool: {},
    });

    const postRoute = router.stack.find(
      (entry) => entry.route?.path === '/:id/asistencia' && entry.route.methods.post,
    );
    assert.ok(postRoute, 'POST /:id/asistencia registered');
  });
});
