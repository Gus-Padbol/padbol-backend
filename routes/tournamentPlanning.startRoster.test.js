import test from 'node:test';
import assert from 'node:assert/strict';
import { startPlannedTournament } from './tournamentPlanning.js';

const torneo = { id: 1, deporte: 'padbol', modalidad_plantel: 'dobles', formato_equipo: 'dobles' };
const jugadores = [
  { participante_id: 'p1', nombre: 'Ana' },
  { participante_id: 'p2', nombre: 'Bea' },
];
const equipos = [
  { id: '1', jugadores, inscripcion_estado: 'confirmado' },
  { id: '2', jugadores, inscripcion_estado: 'confirmado' },
];

test('start sends numeric ids even when the SQL transport exposes bigint ids as strings', async () => {
  let sent;
  const db = {
    rpc: async (name, body) => {
      sent = { name, body };
      return { data: { ok: true, estado: 'en_curso', torneo_id: 1 }, error: null };
    },
  };

  const out = await startPlannedTournament(db, { torneo, equipos, actorId: '00000000-0000-4000-8000-0000000000a0' });

  assert.equal(out.estado, 'en_curso');
  assert.equal(sent.name, 'iniciar_torneo_planificado');
  assert.deepEqual(sent.body.p_roster.map((row) => row.id), [1, 2]);
  assert.deepEqual(sent.body.p_roster.map((row) => typeof row.id), ['number', 'number']);
  assert.deepEqual(sent.body.p_roster.map((row) => row.inscripcion_estado), ['confirmado', 'confirmado']);
});

test('start rejects malformed or unsafe team ids before calling the RPC', async () => {
  let calls = 0;
  const db = { rpc: async () => { calls++; return { data: { ok: true } }; } };
  for (const id of ['9007199254740993', '1e0', '0x1', [1], true, null, 0, -1, 1.5]) {
    const roster = [{ ...equipos[0], id }, equipos[1]];
    await assert.rejects(startPlannedTournament(db, { torneo, equipos: roster, actorId: 'fixture' }), error => error.status === 400, JSON.stringify(id));
  }
  assert.equal(calls, 0);
});
