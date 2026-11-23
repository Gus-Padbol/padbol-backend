import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { confirmarInscripcionGratuitaAtomica } from './inscripcionGratuita.js';

/**
 * Prueba de concurrencia real contra un PostgreSQL efímero local.
 * Sólo corre con INSCRIPCION_ATOMIC_PG_URL apuntando a la base dedicada
 * `inscripcion_atomic_test` en 127.0.0.1:55441. Nunca abre otra URL.
 */
const CS = process.env.INSCRIPCION_ATOMIC_PG_URL;
const it = CS ? test : test.skip;
const U = (n) => `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function assertSafeInscripcionPgUrl(url) {
  const raw = String(url || '');
  const refuse = () => {
    throw new Error('REFUSE_NON_LOCAL_INSCRIPCION_PG');
  };
  if (!/^postgres(?:ql)?:\/\//.test(raw) || raw.includes('#')) refuse();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    refuse();
  }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) refuse();
  if (Number(parsed.port) !== 55441) refuse();
  if (parsed.pathname !== '/inscripcion_atomic_test') refuse();
  if ([...parsed.searchParams.keys()].some((key) => key !== 'sslmode')) refuse();
  let effective;
  try {
    effective = new pg.Client({ connectionString: raw }).connectionParameters;
  } catch {
    refuse();
  }
  if (!['127.0.0.1', 'localhost'].includes(effective.host)) refuse();
  if (Number(effective.port) !== 55441 || effective.database !== 'inscripcion_atomic_test') refuse();
  return true;
}

test('la guarda de PG rechaza cualquier destino no local o no dedicado', () => {
  assert.throws(
    () => assertSafeInscripcionPgUrl('postgresql://postgres@db.example.com:55441/inscripcion_atomic_test'),
    /REFUSE/,
  );
  assert.throws(
    () => assertSafeInscripcionPgUrl('postgresql://postgres@127.0.0.1:5432/inscripcion_atomic_test'),
    /REFUSE/,
  );
  assert.throws(
    () => assertSafeInscripcionPgUrl('postgresql://postgres@127.0.0.1:55441/postgres'),
    /REFUSE/,
  );
  assert.equal(
    assertSafeInscripcionPgUrl('postgresql://postgres@127.0.0.1:55441/inscripcion_atomic_test'),
    true,
  );
});

async function fixture({ cap = 2, monto = 0, legacy = null, teams = [] } = {}) {
  assertSafeInscripcionPgUrl(CS);
  const pool = new pg.Pool({ connectionString: CS, max: 8 });
  await pool.query('DROP TABLE IF EXISTS public.torneo_participante_equipos; DROP TABLE IF EXISTS public.torneo_participantes; DROP TABLE IF EXISTS public.equipos; DROP TABLE IF EXISTS public.torneos;');
  await pool.query(`
    CREATE TABLE public.torneos (
      id bigint PRIMARY KEY,
      estado text NOT NULL,
      inscripcion_monto numeric,
      costo_inscripcion numeric,
      cupos_maximos integer
    );
    CREATE TABLE public.equipos (
      id bigint PRIMARY KEY,
      torneo_id bigint NOT NULL,
      creador_id uuid,
      jugadores jsonb,
      inscripcion_estado text
    );
    CREATE TABLE public.torneo_participantes (
      id uuid PRIMARY KEY,
      torneo_id bigint NOT NULL,
      linked_user_id uuid
    );
    CREATE TABLE public.torneo_participante_equipos (
      torneo_id bigint NOT NULL,
      equipo_id bigint NOT NULL,
      participante_id uuid NOT NULL
    );
  `);
  await pool.query(
    `INSERT INTO public.torneos (id, estado, inscripcion_monto, costo_inscripcion, cupos_maximos)
     VALUES ($1, 'inscripcion', $2, $3, $4)`,
    [9001, monto, legacy, cap],
  );
  for (const team of teams) {
    await pool.query(
      `INSERT INTO public.equipos (id, torneo_id, creador_id, jugadores, inscripcion_estado)
       VALUES ($1, 9001, $2, $3::jsonb, $4)`,
      [
        team.id,
        team.creador === null ? null : (team.creador ?? team.actor ?? null),
        JSON.stringify(team.jugadores ?? [{ user_id: team.actor }]),
        team.estado ?? 'pendiente',
      ],
    );
    if (team.actor) {
      const participantId = `99000000-0000-4000-8000-${String(team.id).padStart(12, '0')}`;
      await pool.query(
        'INSERT INTO public.torneo_participantes (id, torneo_id, linked_user_id) VALUES ($1, 9001, $2)',
        [participantId, team.actor],
      );
      await pool.query(
        'INSERT INTO public.torneo_participante_equipos (torneo_id, equipo_id, participante_id) VALUES (9001, $1, $2)',
        [team.id, participantId],
      );
    }
  }
  return pool;
}

async function contarConfirmados(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM public.equipos
      WHERE torneo_id = 9001 AND inscripcion_estado = 'confirmado'`,
  );
  return rows[0].n;
}

it('R02 real PG: dos equipos concurrentes por el último cupo, sólo uno confirma', async () => {
  const pool = await fixture({
    cap: 1,
    teams: [
      { id: 9101, actor: U(1) },
      { id: 9102, actor: U(2) },
    ],
  });
  try {
    const [a, b] = await Promise.allSettled([
      confirmarInscripcionGratuitaAtomica({ pool, torneoId: 9001, equipoId: 9101, actor: { id: U(1) } }),
      confirmarInscripcionGratuitaAtomica({ pool, torneoId: 9001, equipoId: 9102, actor: { id: U(2) } }),
    ]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    const fail = [a, b].filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, JSON.stringify([a, b]));
    assert.equal(fail.length, 1);
    assert.equal(fail[0].reason.code, 'TOURNAMENT_FULL');
    assert.equal(await contarConfirmados(pool), 1);
  } finally {
    await pool.end();
  }
});

it('R02 real PG: dos confirmaciones concurrentes del mismo equipo son idempotentes', async () => {
  const pool = await fixture({
    cap: 2,
    teams: [{ id: 9201, actor: U(1) }],
  });
  try {
    const [a, b] = await Promise.all([
      confirmarInscripcionGratuitaAtomica({ pool, torneoId: 9001, equipoId: 9201, actor: { id: U(1) } }),
      confirmarInscripcionGratuitaAtomica({ pool, torneoId: 9001, equipoId: 9201, actor: { id: U(1) } }),
    ]);
    assert.deepEqual([a.already, b.already].sort(), [false, true]);
    assert.equal(await contarConfirmados(pool), 1);
  } finally {
    await pool.end();
  }
});

it('R01 real PG: null + costo legacy positivo exige pago y no confirma', async () => {
  const pool = await fixture({
    cap: 2,
    monto: null,
    legacy: 1500,
    teams: [{ id: 9301, actor: U(1) }],
  });
  try {
    await assert.rejects(
      () => confirmarInscripcionGratuitaAtomica({ pool, torneoId: 9001, equipoId: 9301, actor: { id: U(1) } }),
      (err) => err.code === 'PAYMENT_REQUIRED',
    );
    assert.equal(await contarConfirmados(pool), 0);
    const { rows } = await pool.query('SELECT inscripcion_estado FROM public.equipos WHERE id=9301');
    assert.equal(rows[0].inscripcion_estado, 'pendiente');
  } finally {
    await pool.end();
  }
});

it('R01 real PG: sin precio configurado rechaza; legacy 0 sí es gratuito', async () => {
  const ausente = await fixture({ cap: 2, monto: null, legacy: null, teams: [{ id: 9311, actor: U(1) }] });
  try {
    await assert.rejects(
      () => confirmarInscripcionGratuitaAtomica({ pool: ausente, torneoId: 9001, equipoId: 9311, actor: { id: U(1) } }),
      (err) => err.code === 'ENROLLMENT_PRICE_MISSING',
    );
    assert.equal(await contarConfirmados(ausente), 0);
  } finally {
    await ausente.end();
  }

  const gratis = await fixture({ cap: 2, monto: null, legacy: 0, teams: [{ id: 9312, actor: U(1) }] });
  try {
    const result = await confirmarInscripcionGratuitaAtomica({
      pool: gratis,
      torneoId: 9001,
      equipoId: 9312,
      actor: { id: U(1) },
    });
    assert.equal(result.already, false);
    assert.equal(await contarConfirmados(gratis), 1);
  } finally {
    await gratis.end();
  }
});

it('R03 real PG: autoriza sólo por relación canónica, no por creador/roster del row', async () => {
  const pool = await fixture({
    cap: 2,
    teams: [
      {
        id: 9401,
        actor: U(2),
        creador: null,
        jugadores: [{ id: U(1), email: 'capitan@example.test' }],
      },
    ],
  });
  try {
    await assert.rejects(
      () => confirmarInscripcionGratuitaAtomica({
        pool,
        torneoId: 9001,
        equipoId: 9401,
        actor: { id: U(1), email: 'capitan@example.test' },
      }),
      (err) => err.code === 'ENROLLMENT_AUTH_UNVERIFIED',
    );
    assert.equal(await contarConfirmados(pool), 0);

    const result = await confirmarInscripcionGratuitaAtomica({
      pool,
      torneoId: 9001,
      equipoId: 9401,
      actor: { id: U(2) },
    });
    assert.equal(result.already, false);
    assert.equal(await contarConfirmados(pool), 1);
  } finally {
    await pool.end();
  }
});
