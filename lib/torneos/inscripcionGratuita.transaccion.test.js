import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmarInscripcionGratuitaAtomica } from './inscripcionGratuita.js';

const ACTOR = '00000000-0000-4000-8000-000000000001';

function equipo(id, { torneoId = 9001, creador = ACTOR, user = ACTOR, estado = 'pendiente' } = {}) {
  return {
    id,
    torneo_id: torneoId,
    creador_id: creador,
    jugadores: [{ user_id: user }],
    inscripcion_estado: estado,
  };
}

function fakePool({ torneo, equipos, canonical = true }) {
  const state = {
    torneo,
    equipos: equipos.map((e) => ({ ...e })),
    queries: [],
    updates: 0,
    released: false,
    canonical,
  };

  const client = {
    async query(sql, params = []) {
      const text = String(sql).trim();
      state.queries.push({ text, params });

      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [] };

      if (/FROM public\.torneos/i.test(text)) {
        return { rows: state.torneo ? [state.torneo] : [] };
      }

      if (/FROM public\.equipos[\s\S]*FOR UPDATE/i.test(text)) {
        const row = state.equipos.find(
          (e) => Number(e.id) === Number(params[0]) && Number(e.torneo_id) === Number(params[1]),
        );
        return { rows: row ? [row] : [] };
      }

      if (/torneo_participante_equipos/i.test(text)) {
        return { rows: state.canonical ? [{ ok: 1 }] : [] };
      }

      if (/FROM public\.user_roles/i.test(text)) return { rows: [] };

      if (/count\(\*\)/i.test(text)) {
        const confirmados = state.equipos.filter(
          (e) => Number(e.torneo_id) === Number(params[0]) && e.inscripcion_estado === 'confirmado',
        ).length;
        return { rows: [{ confirmados }] };
      }

      if (/^UPDATE public\.equipos/i.test(text)) {
        const row = state.equipos.find(
          (e) =>
            Number(e.id) === Number(params[0]) &&
            Number(e.torneo_id) === Number(params[1]) &&
            e.inscripcion_estado === 'pendiente',
        );
        if (!row) return { rows: [] };
        row.inscripcion_estado = 'confirmado';
        state.updates += 1;
        return { rows: [{ id: row.id, inscripcion_estado: row.inscripcion_estado }] };
      }

      throw new Error(`Consulta inesperada en fakePool: ${text}`);
    },
    release() {
      state.released = true;
    },
  };

  return {
    state,
    pool: { async connect() { return client; } },
  };
}

const torneoBase = {
  id: 9001,
  estado: 'inscripcion',
  inscripcion_monto: 0,
  costo_inscripcion: null,
  cupos_maximos: 2,
};

test('R02: confirma dentro de BEGIN/locks/count/UPDATE/COMMIT', async () => {
  const { state, pool } = fakePool({ torneo: torneoBase, equipos: [equipo(101)] });

  const result = await confirmarInscripcionGratuitaAtomica({
    pool,
    torneoId: 9001,
    equipoId: 101,
    actor: { id: ACTOR },
  });

  assert.deepEqual(result, {
    ok: true,
    gratis: true,
    already: false,
    equipo_id: 101,
    torneo_id: 9001,
    inscripcion_estado: 'confirmado',
  });
  assert.equal(state.equipos[0].inscripcion_estado, 'confirmado');
  assert.equal(state.updates, 1);
  assert.equal(state.released, true);

  const kinds = state.queries.map((q) => q.text);
  assert.match(kinds[0], /^BEGIN$/i);
  assert.match(kinds[1], /FROM public\.torneos[\s\S]*FOR UPDATE/i);
  assert.match(kinds[2], /FROM public\.equipos[\s\S]*FOR UPDATE/i);
  assert.ok(kinds.some((q) => /torneo_participante_equipos/i.test(q)));
  assert.ok(kinds.some((q) => /count\(\*\)/i.test(q)));
  assert.ok(kinds.some((q) => /^UPDATE public\.equipos/i.test(q)));
  assert.ok(kinds.some((q) => /^COMMIT$/i.test(q)));
  assert.equal(state.queries.some((q) => /^ROLLBACK$/i.test(q.text)), false);
});

test('R02: con el último cupo ocupado no actualiza y hace ROLLBACK', async () => {
  const { state, pool } = fakePool({
    torneo: { ...torneoBase, cupos_maximos: 1 },
    equipos: [equipo(101, { estado: 'confirmado', user: '00000000-0000-4000-8000-000000000002' }), equipo(102)],
  });

  await assert.rejects(
    () => confirmarInscripcionGratuitaAtomica({ pool, torneoId: 9001, equipoId: 102, actor: { id: ACTOR } }),
    (err) => err.code === 'TOURNAMENT_FULL',
  );

  assert.equal(state.equipos[1].inscripcion_estado, 'pendiente');
  assert.equal(state.updates, 0);
  assert.equal(state.released, true);
  assert.equal(state.queries.some((q) => /^ROLLBACK$/i.test(q.text)), true);
});

test('R01/R02: precio legacy positivo o ausente rechaza dentro de la transacción', async () => {
  const pago = fakePool({
    torneo: { ...torneoBase, inscripcion_monto: null, costo_inscripcion: 1500 },
    equipos: [equipo(201)],
  });
  await assert.rejects(
    () => confirmarInscripcionGratuitaAtomica({ pool: pago.pool, torneoId: 9001, equipoId: 201, actor: { id: ACTOR } }),
    (err) => err.code === 'PAYMENT_REQUIRED',
  );
  assert.equal(pago.state.updates, 0);
  assert.equal(pago.state.queries.some((q) => /^ROLLBACK$/i.test(q.text)), true);

  const ausente = fakePool({
    torneo: { ...torneoBase, inscripcion_monto: null, costo_inscripcion: null },
    equipos: [equipo(202)],
  });
  await assert.rejects(
    () => confirmarInscripcionGratuitaAtomica({ pool: ausente.pool, torneoId: 9001, equipoId: 202, actor: { id: ACTOR } }),
    (err) => err.code === 'ENROLLMENT_PRICE_MISSING',
  );
  assert.equal(ausente.state.updates, 0);
});

test('R02: inscripción ya confirmada es idempotente y no vuelve a actualizar', async () => {
  const { state, pool } = fakePool({
    torneo: torneoBase,
    equipos: [equipo(301, { estado: 'confirmado' })],
  });

  const result = await confirmarInscripcionGratuitaAtomica({
    pool,
    torneoId: 9001,
    equipoId: 301,
    actor: { id: ACTOR },
  });

  assert.equal(result.already, true);
  assert.equal(result.inscripcion_estado, 'confirmado');
  assert.equal(state.updates, 0);
  assert.equal(state.queries.some((q) => /^COMMIT$/i.test(q.text)), true);
});

test('R03/R02: sin relación canónica no actualiza', async () => {
  const { state, pool } = fakePool({
    torneo: torneoBase,
    equipos: [equipo(401, { creador: ACTOR, user: ACTOR })],
    canonical: false,
  });

  await assert.rejects(
    () => confirmarInscripcionGratuitaAtomica({
      pool,
      torneoId: 9001,
      equipoId: 401,
      actor: { id: ACTOR, email: 'capitan@example.test' },
    }),
    (err) => err.code === 'ENROLLMENT_AUTH_UNVERIFIED',
  );

  assert.equal(state.equipos[0].inscripcion_estado, 'pendiente');
  assert.equal(state.updates, 0);
});

test('R02: sin pgPool falla cerrado en 503', async () => {
  await assert.rejects(
    () => confirmarInscripcionGratuitaAtomica({ pool: null, torneoId: 9001, equipoId: 501, actor: { id: ACTOR } }),
    (err) => err.code === 'ENROLLMENT_ATOMIC_UNAVAILABLE' && err.status === 503,
  );
  await assert.rejects(
    () => confirmarInscripcionGratuitaAtomica({
      pool: { async connect() { throw new Error('sin conexión'); } },
      torneoId: 9001,
      equipoId: 501,
      actor: { id: ACTOR },
    }),
    (err) => err.code === 'ENROLLMENT_ATOMIC_UNAVAILABLE' && err.status === 503,
  );
});
