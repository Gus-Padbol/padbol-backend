import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { mountMatchAttendanceAdminRoutes } from '../src/routes/matchAttendanceAdmin.js';
import {
  isAttendanceConfirmationEnabledForMatch,
  isMatchAttendanceConfirmationEnabled,
  resolveAttendanceConfirmationEnabled,
} from '../src/matches/matchAttendanceConfig.js';
import {
  MATCH_ATTENDANCE_AUDIT_ACTIONS,
  appendMatchAttendanceAuditLog,
} from '../src/matches/matchAttendanceAuditService.js';
import {
  adminForceCloseAttendanceCollection,
  adminOverrideParticipantAttendance,
  adminReprocessAttendanceRewards,
  getAdminMatchAttendanceDetail,
  mapAdminAttendanceParticipant,
  userCanManageMatchAttendance,
} from '../src/matches/matchAttendanceAdminService.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_RESOLUTION_REASON,
  MATCH_ATTENDANCE_STATUS,
  MATCH_REWARD_STATUS,
  MATCH_TYPES,
} from '../src/matches/matchParticipantsConstants.js';
import { getSedeAttendanceConfirmationEnabled } from '../src/matches/matchAttendanceSedeConfigService.js';
import {
  getPlayerAttendanceState,
  submitPlayerAttendanceResponse,
} from '../src/matches/matchAttendanceService.js';

const PARTIDO_ID = 120;
const SEDE_ID = 3;
const OTHER_SEDE_ID = 9;
const CAPTAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const PLAYER_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';
const SUPER_ADMIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-444444444444';
const ADMIN_CLUB_ID = 'aaaaaaaa-bbbb-cccc-dddd-555555555555';
const OPENED_AT = '2026-07-10T12:00:00.000Z';
const DEADLINE_AT = '2026-07-13T12:00:00.000Z';
const NOW = '2026-07-11T12:00:00.000Z';

function openPartido(overrides = {}) {
  return {
    id: PARTIDO_ID,
    sede_id: SEDE_ID,
    capitan_user_id: CAPTAIN_ID,
    estado: 'finalizado',
    ganador: 'equipo1',
    attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN,
    attendance_opened_at: OPENED_AT,
    attendance_deadline_at: DEADLINE_AT,
    attendance_resolved_at: null,
    attendance_resolution_reason: null,
    rewards_processed_at: null,
    partido_torneo_id: null,
    torneo_id: null,
    ...overrides,
  };
}

function participantRow(userId, overrides = {}) {
  return {
    id: 1,
    user_id: userId,
    match_type: MATCH_TYPES.CASUAL,
    match_id: String(PARTIDO_ID),
    role: 'participant',
    team: 'equipo1',
    attendance_status: MATCH_ATTENDANCE_STATUS.PENDING,
    attendance_confirmed_at: null,
    attendance_requested_at: OPENED_AT,
    attendance_responded_at: null,
    attendance_response_source: null,
    attendance_denial_reason: null,
    reward_status: MATCH_REWARD_STATUS.PENDING,
    ...overrides,
  };
}

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
      neq() { return this; },
      then(resolve) {
        let matched = [...rows];
        const filters = this._filters;
        if (filters.match_type != null) matched = matched.filter((r) => r.match_type === filters.match_type);
        if (filters.match_id != null) matched = matched.filter((r) => String(r.match_id) === String(filters.match_id));
        if (filters.user_id != null) matched = matched.filter((r) => r.user_id === filters.user_id);
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
          neq(field, value) {
            filters[`!${field}`] = value;
            return builder;
          },
          select() { return builder; },
          maybeSingle: async () => {
            const row = rows.find((r) => {
              const eqMatch = Object.entries(filters)
                .filter(([k]) => !k.startsWith('!'))
                .every(([k, v]) => String(r[k.replace('!', '')]) === String(v));
              const neqMatch = Object.entries(filters)
                .filter(([k]) => k.startsWith('!'))
                .every(([k, v]) => String(r[k.slice(1)]) !== String(v));
              return eqMatch && neqMatch;
            });
            if (row) Object.assign(row, payload);
            return { data: row ?? null, error: null };
          },
          single: async () => {
            const result = await builder.maybeSingle();
            return { data: result.data, error: result.data ? null : { message: 'not found' } };
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
      neq(field, value) {
        this._filters[`!${field}`] = value;
        return this;
      },
      update(payload) {
        this._updatePayload = payload;
        return this;
      },
      order() { return this; },
      limit() { return this; },
      maybeSingle: async function maybeSingle() {
        const filters = { ...this._filters };
        this._filters = {};
        const updatePayload = this._updatePayload;
        this._updatePayload = null;
        const matches = (candidate) => {
          const eqOk = Object.entries(filters)
            .filter(([k]) => !k.startsWith('!'))
            .every(([k, v]) => String(candidate[k]) === String(v));
          const neqOk = Object.entries(filters)
            .filter(([k]) => k.startsWith('!'))
            .every(([k, v]) => String(candidate[k.slice(1)]) !== String(v));
          return eqOk && neqOk;
        };
        if (updatePayload) {
          if (matches(row)) row = { ...row, ...updatePayload };
          return { data: matches(row) ? { ...row } : null, error: null };
        }
        return { data: matches(row) ? { ...row } : null, error: null };
      },
    },
  };
}

function buildSetupStore(config = null) {
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
        if (!config) return { data: null, error: null };
        const match = Object.entries(filters).every(([k, v]) => String(config[k]) === String(v));
        return { data: match ? { ...config } : null, error: null };
      },
    },
  };
}

function buildPerfilStore(rows = []) {
  return {
    handler: {
      _filters: {},
      select() { return this; },
      in(field, values) {
        this._filters[field] = values;
        return this;
      },
      then(resolve) {
        const values = this._filters.user_id ?? [];
        this._filters = {};
        resolve({
          data: rows.filter((row) => values.includes(row.user_id)),
          error: null,
        });
      },
    },
  };
}

function buildAuditStore() {
  const rows = [];
  return {
    rows,
    handler: {
      insert(payload) {
        const row = { id: `audit-${rows.length + 1}`, created_at: NOW, ...payload };
        rows.push(row);
        return {
          select() { return this; },
          single: async () => ({ data: row, error: null }),
        };
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
      order() { return this; },
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

function createPhase36Mock({
  partido,
  participants = [],
  sedeConfig = null,
  perfiles = [],
  auditTableMissing = false,
  jugadores = [{ partido_id: PARTIDO_ID, user_id: CAPTAIN_ID, id: 1 }],
} = {}) {
  const participantsStore = buildParticipantsStore(participants);
  const partidoStore = buildPartidoStore(partido);
  const setupStore = buildSetupStore(sedeConfig);
  const perfilStore = buildPerfilStore(perfiles);
  const auditStore = buildAuditStore();
  const jugadoresStore = buildJugadoresStore(jugadores);

  return {
    participantsStore,
    partidoStore,
    auditStore,
    from(table) {
      if (table === 'partidos_abiertos') return partidoStore.handler;
      if (table === 'match_participants') return participantsStore.handler;
      if (table === 'padbol_match_setup_status') return setupStore.handler;
      if (table === 'jugadores_perfil') return perfilStore.handler;
      if (table === 'match_attendance_audit_log') {
        if (auditTableMissing) {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: '42P01', message: 'match_attendance_audit_log does not exist' },
                }),
              }),
            }),
          };
        }
        return auditStore.handler;
      }
      if (table === 'partidos_abiertos_jugadores') return jugadoresStore.handler;
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('matchAttendance Fase 3.6 — configuración global/sede', () => {
  const original = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (original == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = original;
  });

  it('global OFF + sede OFF → false', () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    assert.equal(resolveAttendanceConfirmationEnabled({ globalEnabled: false, sedeEnabled: false }), false);
    assert.equal(isAttendanceConfirmationEnabledForMatch({ sede_id: SEDE_ID }, { sedeEnabled: false }), false);
  });

  it('global OFF + sede ON → true', () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    assert.equal(isAttendanceConfirmationEnabledForMatch({ sede_id: SEDE_ID }, { sedeEnabled: true }), true);
  });

  it('global ON + sede OFF → true', () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    assert.equal(isAttendanceConfirmationEnabledForMatch({ sede_id: SEDE_ID }, { sedeEnabled: false }), true);
  });

  it('flags globales apagados por defecto', () => {
    delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    assert.equal(isMatchAttendanceConfirmationEnabled(), false);
  });

  it('getSedeAttendanceConfirmationEnabled default false sin fila', async () => {
    const mock = createPhase36Mock({ partido: openPartido(), sedeConfig: null });
    assert.equal(await getSedeAttendanceConfirmationEnabled(mock, SEDE_ID), false);
  });

  it('getSedeAttendanceConfirmationEnabled true cuando columna activa', async () => {
    const mock = createPhase36Mock({
      partido: openPartido(),
      sedeConfig: { sede_id: SEDE_ID, attendance_confirmation_enabled: true },
    });
    assert.equal(await getSedeAttendanceConfirmationEnabled(mock, SEDE_ID), true);
  });
});

describe('matchAttendance Fase 3.6 — permisos admin', () => {
  const partido = openPartido();

  it('super_admin accede', async () => {
    const ok = await userCanManageMatchAttendance(
      { id: SUPER_ADMIN_ID },
      partido,
      { fetchUserRoleRowForAuthUser: async () => ({ role: 'super_admin', sede_id: null }) },
    );
    assert.equal(ok, true);
  });

  it('admin_club de la sede accede', async () => {
    const ok = await userCanManageMatchAttendance(
      { id: ADMIN_CLUB_ID },
      partido,
      { fetchUserRoleRowForAuthUser: async () => ({ role: 'admin_club', sede_id: SEDE_ID }) },
    );
    assert.equal(ok, true);
  });

  it('admin_club de otra sede → false', async () => {
    const ok = await userCanManageMatchAttendance(
      { id: ADMIN_CLUB_ID },
      partido,
      { fetchUserRoleRowForAuthUser: async () => ({ role: 'admin_club', sede_id: OTHER_SEDE_ID }) },
    );
    assert.equal(ok, false);
  });

  it('usuario común → false', async () => {
    const ok = await userCanManageMatchAttendance(
      { id: PLAYER_ID },
      partido,
      { fetchUserRoleRowForAuthUser: async () => ({ role: 'jugador', sede_id: null }) },
    );
    assert.equal(ok, false);
  });

  it('capitán sin rol admin → false', async () => {
    const ok = await userCanManageMatchAttendance(
      { id: CAPTAIN_ID },
      partido,
      { fetchUserRoleRowForAuthUser: async () => ({ role: 'jugador', sede_id: SEDE_ID }) },
    );
    assert.equal(ok, false);
  });
});

describe('matchAttendance Fase 3.6 — detalle admin sin PII', () => {
  it('listado admin sin email/teléfono', async () => {
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [participantRow(PLAYER_ID)],
      perfiles: [{ user_id: PLAYER_ID, nombre: 'Ana', apodo: 'Anita', email: 'secret@example.com' }],
    });

    const detail = await getAdminMatchAttendanceDetail(mock, PARTIDO_ID);
    assert.equal(detail.ok, true);
    assert.equal(detail.participants.length, 1);
    assert.equal(detail.participants[0].display_name, 'Anita');
    assert.equal(detail.participants[0].email, undefined);
    assert.equal(detail.participants[0].attendance_status, MATCH_ATTENDANCE_STATUS.PENDING);
    assert.equal(JSON.stringify(detail).includes('secret@example.com'), false);
  });

  it('mapAdminAttendanceParticipant no expone reward_status alterado en mapper', () => {
    const mapped = mapAdminAttendanceParticipant(participantRow(PLAYER_ID), new Map([[PLAYER_ID, 'Ana']]));
    assert.equal(mapped.reward_status, MATCH_REWARD_STATUS.PENDING);
    assert.equal(mapped.display_name, 'Ana');
  });
});

describe('matchAttendance Fase 3.6 — override individual', () => {
  const originalFlag = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (originalFlag == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = originalFlag;
  });

  it('override pending → admin_validated recalcula ready y dispara recompensas', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [
        participantRow(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        participantRow(OTHER_ID),
      ],
    });

    let finalizeCalls = 0;
    const result = await adminOverrideParticipantAttendance(mock, PARTIDO_ID, OTHER_ID, {
      status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      reason: 'validado en recepción',
      actor: { user_id: ADMIN_CLUB_ID, role: 'admin_club' },
      now: new Date(NOW),
      deps: {
        tryFinalizeMatchAttendanceRewards: async () => {
          finalizeCalls += 1;
          return {
            credited: true,
            partidoFields: {
              collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
              rewards_processed_at: NOW,
            },
            rewards: { processed: true, padcoins: { ok: true }, ranking: { ok: true } },
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.participant.attendance_status, MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED);
    assert.equal(result.participant.reward_status, MATCH_REWARD_STATUS.PENDING);
    assert.equal(finalizeCalls, 1);
    assert.equal(mock.auditStore.rows.length, 1);
    assert.equal(mock.auditStore.rows[0].action, MATCH_ATTENDANCE_AUDIT_ACTIONS.PARTICIPANT_OVERRIDE);
  });

  it('override pending → excluded mantiene open si quedan pending', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [
        participantRow(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
        participantRow(OTHER_ID),
        participantRow(CAPTAIN_ID, { id: 3, attendance_status: MATCH_ATTENDANCE_STATUS.PENDING }),
      ],
    });

    const result = await adminOverrideParticipantAttendance(mock, PARTIDO_ID, OTHER_ID, {
      status: MATCH_ATTENDANCE_STATUS.EXCLUDED,
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
      now: new Date(NOW),
    });

    assert.equal(result.ok, true);
    assert.equal(result.participant.attendance_status, MATCH_ATTENDANCE_STATUS.EXCLUDED);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
    assert.equal(result.rewards.processed, false);
  });

  it('credited bloquea cambios', async () => {
    const mock = createPhase36Mock({
      partido: openPartido({
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.CREDITED,
        rewards_processed_at: NOW,
      }),
      participants: [participantRow(PLAYER_ID)],
    });

    const result = await adminOverrideParticipantAttendance(mock, PARTIDO_ID, PLAYER_ID, {
      status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'credited_locked');
  });

  it('torneo y cancelado rechazados', async () => {
    const torneoMock = createPhase36Mock({
      partido: openPartido({ torneo_id: 77 }),
      participants: [participantRow(PLAYER_ID)],
    });
    const torneoResult = await adminOverrideParticipantAttendance(torneoMock, PARTIDO_ID, PLAYER_ID, {
      status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
    });
    assert.equal(torneoResult.reason, 'torneo_out_of_scope');

    const cancelMock = createPhase36Mock({
      partido: openPartido({ estado: 'cancelado' }),
      participants: [participantRow(PLAYER_ID)],
    });
    const cancelResult = await adminOverrideParticipantAttendance(cancelMock, PARTIDO_ID, PLAYER_ID, {
      status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
    });
    assert.equal(cancelResult.reason, 'partido_cancelado');
  });
});

describe('matchAttendance Fase 3.6 — cierre forzado', () => {
  it('cerrar ready con elegibles', async () => {
    process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = 'true';
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [
        participantRow(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
      ],
    });

    const result = await adminForceCloseAttendanceCollection(mock, PARTIDO_ID, {
      action: 'ready',
      reason: 'resolución manual',
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
      now: new Date(NOW),
      deps: {
        tryFinalizeMatchAttendanceRewards: async () => ({
          rewards: { processed: false, padcoins: { ok: false }, ranking: { ok: false } },
        }),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.READY);
    assert.equal(result.match.resolution_reason, MATCH_ATTENDANCE_RESOLUTION_REASON.ADMIN_OVERRIDE);
  });

  it('cerrar ready sin elegibles → error', async () => {
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [
        participantRow(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.EXCLUDED }),
      ],
    });

    const result = await adminForceCloseAttendanceCollection(mock, PARTIDO_ID, {
      action: 'ready',
      reason: 'sin elegibles',
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_eligible_participants');
  });

  it('cerrar blocked no acredita', async () => {
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [participantRow(PLAYER_ID)],
    });

    const result = await adminForceCloseAttendanceCollection(mock, PARTIDO_ID, {
      action: 'blocked',
      reason: 'disputa sin resolución',
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
      now: new Date(NOW),
    });

    assert.equal(result.ok, true);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.BLOCKED);
    assert.equal(result.rewards.padcoins.ok, false);
  });
});

describe('matchAttendance Fase 3.6 — reproceso', () => {
  it('reprocesar ready idempotente', async () => {
    const mock = createPhase36Mock({
      partido: openPartido({
        attendance_collection_status: MATCH_ATTENDANCE_COLLECTION_STATUS.READY,
        attendance_resolved_at: NOW,
        attendance_resolution_reason: MATCH_ATTENDANCE_RESOLUTION_REASON.ALL_RESPONDED,
      }),
      participants: [
        participantRow(PLAYER_ID, { attendance_status: MATCH_ATTENDANCE_STATUS.CONFIRMED }),
      ],
    });

    let calls = 0;
    const result = await adminReprocessAttendanceRewards(mock, PARTIDO_ID, {
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
      deps: {
        tryFinalizeMatchAttendanceRewards: async () => {
          calls += 1;
          return {
            idempotent: true,
            skipped: true,
            rewards: { processed: true, padcoins: { ok: true, reason: 'already_credited' }, ranking: { ok: true } },
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.idempotent, true);
    assert.equal(calls, 1);
  });

  it('reproceso rechaza si no está ready', async () => {
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [participantRow(PLAYER_ID)],
    });
    const result = await adminReprocessAttendanceRewards(mock, PARTIDO_ID, {
      actor: { user_id: SUPER_ADMIN_ID, role: 'super_admin' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_ready');
  });
});

describe('matchAttendance Fase 3.6 — auditoría', () => {
  it('auditoría registrada', async () => {
    const mock = createPhase36Mock({ partido: openPartido(), participants: [participantRow(PLAYER_ID)] });
    const audit = await appendMatchAttendanceAuditLog(mock, {
      match_id: PARTIDO_ID,
      actor_user_id: SUPER_ADMIN_ID,
      actor_role: 'super_admin',
      action: MATCH_ATTENDANCE_AUDIT_ACTIONS.PARTICIPANT_OVERRIDE,
      target_user_id: PLAYER_ID,
      previous_status: MATCH_ATTENDANCE_STATUS.PENDING,
      new_status: MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED,
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.skipped, false);
    assert.equal(mock.auditStore.rows.length, 1);
  });

  it('fallback si tabla audit todavía no existe', async () => {
    const mock = createPhase36Mock({
      partido: openPartido(),
      participants: [participantRow(PLAYER_ID)],
      auditTableMissing: true,
    });
    const audit = await appendMatchAttendanceAuditLog(mock, {
      match_id: PARTIDO_ID,
      action: MATCH_ATTENDANCE_AUDIT_ACTIONS.REPROCESS_REWARDS,
    });
    assert.equal(audit.ok, true);
    assert.equal(audit.skipped, true);
    assert.equal(audit.reason, 'audit_table_missing');
  });
});

function buildSubmitPhase36Mock({
  sedeConfig = null,
  sedeConfigError = null,
  globalEnabled,
} = {}) {
  if (globalEnabled == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
  else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = globalEnabled ? 'true' : 'false';

  const base = createPhase36Mock({
    partido: openPartido(),
    participants: [
      participantRow(PLAYER_ID),
      participantRow(OTHER_ID, { id: 2, user_id: OTHER_ID }),
    ],
    sedeConfig,
    jugadores: [
      { partido_id: PARTIDO_ID, user_id: PLAYER_ID, id: 1 },
      { partido_id: PARTIDO_ID, user_id: OTHER_ID, id: 2 },
    ],
  });

  if (!sedeConfigError) return base;

  return {
    ...base,
    from(table) {
      if (table === 'padbol_match_setup_status') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: sedeConfigError }),
        };
      }
      return base.from(table);
    },
  };
}

describe('matchAttendance Fase 3.6 — submitPlayerAttendanceResponse sede flag', () => {
  const original = process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;

  afterEach(() => {
    if (original == null) delete process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED;
    else process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED = original;
  });

  it('global OFF + sede OFF → 409 feature_disabled', async () => {
    const mock = buildSubmitPhase36Mock({
      sedeConfig: { sede_id: SEDE_ID, attendance_confirmation_enabled: false },
    });
    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.httpStatus, 409);
    assert.equal(result.reason, 'feature_disabled');
  });

  it('global OFF + sede sin fila → 409 feature_disabled', async () => {
    const mock = buildSubmitPhase36Mock({ sedeConfig: null });
    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.httpStatus, 409);
    assert.equal(result.reason, 'feature_disabled');
  });

  it('global OFF + sede ON → confirm permitido', async () => {
    const mock = buildSubmitPhase36Mock({
      sedeConfig: { sede_id: SEDE_ID, attendance_confirmation_enabled: true },
    });
    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.CONFIRMED);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
    assert.equal(
      mock.participantsStore.rows.find((r) => r.user_id === PLAYER_ID).reward_status,
      MATCH_REWARD_STATUS.PENDING,
    );
  });

  it('global OFF + sede ON → deny permitido', async () => {
    const mock = buildSubmitPhase36Mock({
      sedeConfig: { sede_id: SEDE_ID, attendance_confirmation_enabled: true },
    });
    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'deny', reason: 'no fui' },
      { now: new Date(NOW) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.DENIED);
    assert.equal(
      mock.participantsStore.rows.find((r) => r.user_id === PLAYER_ID).reward_status,
      MATCH_REWARD_STATUS.PENDING,
    );
  });

  it('global ON + sede OFF → permitido', async () => {
    const mock = buildSubmitPhase36Mock({
      globalEnabled: true,
      sedeConfig: { sede_id: SEDE_ID, attendance_confirmation_enabled: false },
    });
    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.player.attendance_status, MATCH_ATTENDANCE_STATUS.CONFIRMED);
  });

  it('error controlado de lectura de sede → 409 feature_disabled', async () => {
    const mock = buildSubmitPhase36Mock({
      sedeConfigError: { code: '42703', message: 'attendance_confirmation_enabled does not exist' },
    });
    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.httpStatus, 409);
    assert.equal(result.reason, 'feature_disabled');
  });

  it('GET y POST resuelven el mismo feature_enabled con sede ON', async () => {
    const mock = buildSubmitPhase36Mock({
      sedeConfig: { sede_id: SEDE_ID, attendance_confirmation_enabled: true },
    });
    const getState = await getPlayerAttendanceState(mock, PARTIDO_ID, PLAYER_ID);
    assert.equal(getState.ok, true);
    assert.equal(getState.match.feature_enabled, true);

    const postResult = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(postResult.ok, true);
    assert.notEqual(postResult.reason, 'feature_disabled');
  });

  it('confirm con sede ON no acredita recompensas antes de ready', async () => {
    const mock = buildSubmitPhase36Mock({
      sedeConfig: { sede_id: SEDE_ID, attendance_confirmation_enabled: true },
    });
    const result = await submitPlayerAttendanceResponse(
      mock,
      PARTIDO_ID,
      PLAYER_ID,
      { response: 'confirm' },
      { now: new Date(NOW) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.match.collection_status, MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN);
    assert.equal(result.match.rewards_processed_at, null);
    assert.notEqual(result.rewards?.processed, true);
    assert.equal(result.rewards?.padcoins?.reason, 'not_ready');
  });
});

describe('matchAttendance Fase 3.6 — rutas admin registradas', () => {
  it('monta endpoints admin de asistencia', () => {
    const routes = [];
    const app = {
      get(path, handler) { routes.push(['GET', path, handler]); },
      post(path, handler) { routes.push(['POST', path, handler]); },
    };
    mountMatchAttendanceAdminRoutes(app, {
      supabaseAdmin: {},
      getAuthenticatedUser: async () => ({ user: null, status: 401, error: 'No autorizado' }),
      fetchUserRoleRowForAuthUser: async () => null,
    });

    const paths = routes.map((r) => r[1]);
    assert.equal(paths.includes('/api/admin/partidos/:id/asistencia'), true);
    assert.equal(paths.includes('/api/admin/partidos/:id/asistencia/participantes/:userId'), true);
    assert.equal(paths.includes('/api/admin/partidos/:id/asistencia/cerrar'), true);
    assert.equal(paths.includes('/api/admin/partidos/:id/asistencia/reprocesar'), true);
  });
});
