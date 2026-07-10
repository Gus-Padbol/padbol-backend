import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { createPartidosRouter } from '../routes/partidos.js';
import {
  isMatchAttendanceConfirmationEnabled,
  parseMatchAttendanceTruthyEnv,
} from '../src/matches/matchAttendanceConfig.js';
import {
  ELIGIBLE_ATTENDANCE_STATUSES,
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_STATUS,
  normalizeAttendanceCollectionStatus,
  normalizeAttendanceStatus,
} from '../src/matches/matchParticipantsConstants.js';
import {
  buildLegacyPartidoAttendanceFields,
  buildMatchAttendanceSummary,
  computeCanRespondToAttendance,
  computeEligibleParticipantCount,
  countParticipantsByAttendanceStatus,
  getMatchAttendanceState,
  getPlayerAttendanceState,
  isMissingMatchAttendanceColumnError,
  normalizePartidoAttendanceFields,
  userCanViewAttendanceSummary,
} from '../src/matches/matchAttendanceService.js';

const PARTIDO_ID = 55;
const SEDE_ID = 3;
const CAPTAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const PLAYER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const ADMIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-444444444444';

const STATS_COLUMN_ERROR = {
  code: '42703',
  message: 'column "attendance_collection_status" does not exist',
};

function buildParticipantsStore(initial = []) {
  const rows = [...initial];
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
      maybeSingle: async function maybeSingle() {
        const filters = this._filters;
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
      then(resolve) {
        let matched = [...rows];
        const filters = this._filters;
        if (filters.match_type != null) {
          matched = matched.filter((r) => r.match_type === filters.match_type);
        }
        if (filters.match_id != null) {
          matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
        }
        this._filters = {};
        resolve({ data: matched, error: null });
      },
    },
  };
}

function buildPartidosStore(partido, { missingAttendanceColumns = false } = {}) {
  const row = partido ?? null;
  return {
    handler: {
      _filters: {},
      select(cols) {
        this._selectCols = cols;
        return this;
      },
      eq(field, value) {
        this._filters[field] = value;
        return this;
      },
      maybeSingle: async function maybeSingle() {
        if (missingAttendanceColumns && String(this._selectCols ?? '').includes('attendance_collection_status')) {
          return { data: null, error: STATS_COLUMN_ERROR };
        }
        const filters = this._filters;
        this._filters = {};
        this._selectCols = null;
        if (!row) return { data: null, error: null };
        const match = Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
        return { data: match ? row : null, error: null };
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
        const filters = this._filters;
        this._filters = {};
        const row = rows.find((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
        );
        return { data: row ?? null, error: null };
      },
    },
  };
}

function createMockSupabase({
  partido = null,
  participants = [],
  missingAttendanceColumns = false,
  jugadores = [],
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidosStore = buildPartidosStore(partido, { missingAttendanceColumns });
  const jugadoresStore = buildJugadoresStore(jugadores);

  return {
    participantsStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidosStore.handler;
      if (table === 'match_participants') {
        if (missingAttendanceColumns && participantsStore.rows.length) {
          return {
            select(cols) {
              this._cols = cols;
              return this;
            },
            eq() { return this; },
            order() { return this; },
            then(resolve) {
              if (String(this._cols ?? '').includes('attendance_requested_at')) {
                resolve({ data: null, error: STATS_COLUMN_ERROR });
                return;
              }
              resolve({ data: participantsStore.rows, error: null });
            },
          };
        }
        return participantsStore.handler;
      }
      if (table === 'partidos_abiertos_jugadores') return jugadoresStore.handler;
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('matchAttendanceConfig', () => {
  const original = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (original == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = original;
  });

  it('flag ausente → false', () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    assert.equal(isMatchAttendanceConfirmationEnabled(), false);
  });

  it('flag false → false', () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'false';
    assert.equal(isMatchAttendanceConfirmationEnabled(), false);
  });

  it('flag true reconocido → true', () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    assert.equal(isMatchAttendanceConfirmationEnabled(), true);
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = '1';
    assert.equal(parseMatchAttendanceTruthyEnv(process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED), true);
  });
});

describe('matchAttendance normalization', () => {
  it('normaliza estados de collection y attendance', () => {
    assert.equal(
      normalizeAttendanceCollectionStatus('OPEN'),
      MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    );
    assert.equal(
      normalizeAttendanceCollectionStatus('invalid'),
      MATCH_ATTENDANCE_COLLECTION_STATUS.NONE,
    );
    assert.equal(normalizeAttendanceStatus('admin_validated'), MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED);
    assert.equal(isMissingMatchAttendanceColumnError(STATS_COLUMN_ERROR), true);
  });

  it('legacy partido fields cuando faltan columnas', () => {
    const legacy = buildLegacyPartidoAttendanceFields({ id: PARTIDO_ID });
    assert.equal(legacy.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.NONE);
    assert.equal(legacy.opened_at, null);
    assert.equal(legacy.schema_attendance_columns_available, false);
  });
});

describe('matchAttendance summary counts', () => {
  const participants = [
    { user_id: CAPTAIN_ID, attendance_status: 'pending' },
    { user_id: PLAYER_ID, attendance_status: 'confirmed' },
    { user_id: OTHER_ID, attendance_status: 'denied' },
    { user_id: 'aaaaaaaa-bbbb-cccc-dddd-555555555555', attendance_status: 'admin_validated' },
    { user_id: 'aaaaaaaa-bbbb-cccc-dddd-666666666666', attendance_status: 'excluded' },
    { user_id: null, attendance_status: 'confirmed' },
  ];

  it('resume conteos y eligible', () => {
    const counts = countParticipantsByAttendanceStatus(participants);
    assert.equal(counts.total_participants, 5);
    assert.equal(counts.pending, 1);
    assert.equal(counts.confirmed, 1);
    assert.equal(counts.denied, 1);
    assert.equal(counts.admin_validated, 1);
    assert.equal(counts.excluded, 1);
    assert.equal(computeEligibleParticipantCount(participants), 2);
  });

  it('buildMatchAttendanceSummary expone feature_enabled y elegibles', () => {
    const partidoFields = normalizePartidoAttendanceFields({
      id: PARTIDO_ID,
      attendance_collection_status: 'open',
      attendance_opened_at: '2026-07-10T12:00:00Z',
      attendance_deadline_at: '2026-07-13T12:00:00Z',
    });

    const summary = buildMatchAttendanceSummary(partidoFields, participants);
    assert.equal(summary.match_id, PARTIDO_ID);
    assert.equal(summary.collection_status, 'open');
    assert.equal(summary.eligible, 2);
    assert.equal(summary.feature_enabled, false);
  });
});

describe('matchAttendance can_respond', () => {
  it('flag apagado → can_respond false', () => {
    assert.equal(computeCanRespondToAttendance({
      featureEnabled: false,
      collectionStatus: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
      attendanceStatus: MATCH_ATTENDANCE_STATUS.PENDING,
      isParticipant: true,
    }), false);
  });

  it('flag on + open + pending → true si no venció', () => {
    assert.equal(computeCanRespondToAttendance({
      featureEnabled: true,
      collectionStatus: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
      deadlineAt: '2099-01-01T00:00:00Z',
      attendanceStatus: MATCH_ATTENDANCE_STATUS.PENDING,
      isParticipant: true,
    }), true);
  });
});

describe('matchAttendanceService reads', () => {
  it('getPlayerAttendanceState para participante miembro', async () => {
    const supabaseAdmin = createMockSupabase({
      partido: {
        id: PARTIDO_ID,
        sede_id: SEDE_ID,
        capitan_user_id: CAPTAIN_ID,
        attendance_collection_status: 'none',
      },
      participants: [
        { user_id: PLAYER_ID, attendance_status: 'pending', match_type: 'casual', match_id: String(PARTIDO_ID) },
      ],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID, id: 1 }],
    });

    const state = await getPlayerAttendanceState(supabaseAdmin, PARTIDO_ID, PLAYER_ID);
    assert.equal(state.ok, true);
    assert.equal(state.player.is_member, true);
    assert.equal(state.player.can_respond, false);
    assert.equal(state.player.attendance_status, 'pending');
  });

  it('fallback pre-SQL en partido sin columnas nuevas', async () => {
    const supabaseAdmin = createMockSupabase({
      partido: { id: PARTIDO_ID, sede_id: SEDE_ID, capitan_user_id: CAPTAIN_ID },
      missingAttendanceColumns: true,
      participants: [],
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID, id: 1 }],
    });

    const state = await getMatchAttendanceState(supabaseAdmin, PARTIDO_ID);
    assert.equal(state.ok, true);
    assert.equal(state.summary.collection_status, 'none');
    assert.equal(state.summary.schema_attendance_columns_available, false);
  });
});

describe('matchAttendance permissions', () => {
  it('capitán accede al resumen', async () => {
    const allowed = await userCanViewAttendanceSummary(
      { id: CAPTAIN_ID },
      { id: PARTIDO_ID, sede_id: SEDE_ID, capitan_user_id: CAPTAIN_ID },
      { fetchUserRoleRowForAuthUser: async () => null, legacySuperAdminEmails: [] },
    );
    assert.equal(allowed, true);
  });

  it('admin_club de la sede accede al resumen', async () => {
    const allowed = await userCanViewAttendanceSummary(
      { id: ADMIN_ID, email: 'admin@test.com' },
      { id: PARTIDO_ID, sede_id: SEDE_ID, capitan_user_id: CAPTAIN_ID },
      {
        fetchUserRoleRowForAuthUser: async () => ({ role: 'admin_club', sede_id: SEDE_ID }),
        legacySuperAdminEmails: [],
      },
    );
    assert.equal(allowed, true);
  });

  it('usuario común no accede al resumen', async () => {
    const allowed = await userCanViewAttendanceSummary(
      { id: PLAYER_ID, email: 'player@test.com' },
      { id: PARTIDO_ID, sede_id: SEDE_ID, capitan_user_id: CAPTAIN_ID },
      {
        fetchUserRoleRowForAuthUser: async () => ({ role: 'jugador', sede_id: SEDE_ID }),
        legacySuperAdminEmails: [],
      },
    );
    assert.equal(allowed, false);
  });
});

describe('matchAttendance routes registration', () => {
  it('registra GET asistencia y resumen en createPartidosRouter', () => {
    const router = createPartidosRouter({
      supabase: {},
      supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
      getAuthenticatedUser: async () => ({ user: null, status: 401, error: 'auth' }),
      pgPool: {},
    });

    const playerRoute = router.stack.find(
      (entry) => entry.route?.path === '/:id/asistencia' && entry.route.methods.get,
    );
    const summaryRoute = router.stack.find(
      (entry) => entry.route?.path === '/:id/asistencia/resumen' && entry.route.methods.get,
    );

    assert.ok(playerRoute, 'GET /:id/asistencia registered');
    assert.ok(summaryRoute, 'GET /:id/asistencia/resumen registered');
  });
});

describe('matchAttendance no side effects', () => {
  it('lecturas no mutan participantes ni recompensas', async () => {
    const participants = [
      {
        user_id: PLAYER_ID,
        attendance_status: 'admin_validated',
        match_type: 'casual',
        match_id: String(PARTIDO_ID),
        reward_status: 'eligible',
      },
    ];
    const supabaseAdmin = createMockSupabase({
      partido: {
        id: PARTIDO_ID,
        sede_id: SEDE_ID,
        capitan_user_id: CAPTAIN_ID,
        attendance_collection_status: 'none',
      },
      participants,
      jugadores: [{ partido_id: PARTIDO_ID, user_id: PLAYER_ID, id: 1 }],
    });

    await getMatchAttendanceState(supabaseAdmin, PARTIDO_ID);
    await getPlayerAttendanceState(supabaseAdmin, PARTIDO_ID, PLAYER_ID);

    assert.equal(participants[0].attendance_status, 'admin_validated');
    assert.equal(participants[0].reward_status, 'eligible');
    assert.ok(ELIGIBLE_ATTENDANCE_STATUSES.has('admin_validated'));
  });
});
