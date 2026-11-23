import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluarInscripcionGratuita,
  precioInscripcionTorneo,
} from './inscripcionGratuita.js';

const actor = { id: 'uuid-capitan', email: 'capitan@example.test' };
const base = {
  torneo: { id: 7, estado: 'inscripcion', inscripcion_monto: 0, cupos_maximos: 8 },
  equipo: { id: 11, torneo_id: 7, creador_id: actor.id, jugadores: [], inscripcion_estado: 'pendiente' },
  actor,
  confirmedCount: 0,
  canonicalRelation: true,
};

function throwsCode(fn, code) {
  return assert.throws(fn, (err) => err?.code === code);
}

test('R01: monto explícito 0 es gratis y confirma una sola vez', () => {
  assert.deepEqual(evaluarInscripcionGratuita(base), { ok: true, gratis: true, already: false });
  assert.deepEqual(
    evaluarInscripcionGratuita({ ...base, equipo: { ...base.equipo, inscripcion_estado: 'confirmado' } }),
    { ok: true, gratis: true, already: true },
  );
});

test('R01: inscripcion_monto null cae al costo legacy, no se convierte en 0', () => {
  assert.equal(precioInscripcionTorneo({ inscripcion_monto: null, costo_inscripcion: 1500 }), 1500);
  assert.equal(precioInscripcionTorneo({ inscripcion_monto: undefined, costo_inscripcion: 900 }), 900);
  assert.equal(precioInscripcionTorneo({ inscripcion_monto: '', costo_inscripcion: '900.50' }), 900.5);
  assert.equal(precioInscripcionTorneo({ inscripcion_monto: '   ', costo_inscripcion: 0 }), 0);

  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, inscripcion_monto: null, costo_inscripcion: 1500 } }),
    'PAYMENT_REQUIRED',
  );
  assert.deepEqual(
    evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, inscripcion_monto: null, costo_inscripcion: 0 } }),
    { ok: true, gratis: true, already: false },
  );
});

test('R01: precio explícito 0 tiene precedencia sobre legacy positivo', () => {
  assert.equal(precioInscripcionTorneo({ inscripcion_monto: 0, costo_inscripcion: 1500 }), 0);
  assert.equal(precioInscripcionTorneo({ inscripcion_monto: '0', costo_inscripcion: '1500' }), 0);
});

test('R01: precio inválido se rechaza y no cae al legacy', () => {
  for (const value of ['abc', -1, '-5', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    throwsCode(() => precioInscripcionTorneo({ inscripcion_monto: value, costo_inscripcion: 1500 }), 'ENROLLMENT_PRICE_INVALID');
  }
  throwsCode(() => precioInscripcionTorneo({ costo_inscripcion: 'gratis' }), 'ENROLLMENT_PRICE_INVALID');
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, inscripcion_monto: 'abc', costo_inscripcion: 1500 } }),
    'ENROLLMENT_PRICE_INVALID',
  );
});

test('R01: sin precio configurado no se asume gratis', () => {
  throwsCode(() => precioInscripcionTorneo({}), 'ENROLLMENT_PRICE_MISSING');
  throwsCode(() => precioInscripcionTorneo({ inscripcion_monto: null, costo_inscripcion: null }), 'ENROLLMENT_PRICE_MISSING');
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, inscripcion_monto: null, costo_inscripcion: null } }),
    'ENROLLMENT_PRICE_MISSING',
  );
});

test('R01: precio positivo moderno o legacy exige pago verificado', () => {
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, inscripcion_monto: 1500 } }),
    'PAYMENT_REQUIRED',
  );
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, inscripcion_monto: null, costo_inscripcion: 900 } }),
    'PAYMENT_REQUIRED',
  );
});

test('R03: sin relación canónica no autoriza aunque el row declare creador o roster', () => {
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, canonicalRelation: false }),
    'ENROLLMENT_AUTH_UNVERIFIED',
  );
  throwsCode(
    () => evaluarInscripcionGratuita({
      ...base,
      canonicalRelation: false,
      equipo: { ...base.equipo, jugadores: [{ user_id: actor.id, email: actor.email }] },
    }),
    'ENROLLMENT_AUTH_UNVERIFIED',
  );
  throwsCode(
    () => evaluarInscripcionGratuita({
      ...base,
      canonicalRelation: false,
      equipo: { ...base.equipo, creador_id: actor.id },
    }),
    'ENROLLMENT_AUTH_UNVERIFIED',
  );
});

test('R03: con relación canónica confiable autoriza; sin actor no autoriza', () => {
  assert.deepEqual(evaluarInscripcionGratuita(base), { ok: true, gratis: true, already: false });
  throwsCode(() => evaluarInscripcionGratuita({ ...base, actor: {} }), 'AUTH_REQUIRED');
});

test('valida pertenencia, estado y cupo', () => {
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, equipo: { ...base.equipo, torneo_id: 99 } }),
    'TEAM_TOURNAMENT_MISMATCH',
  );
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, estado: 'finalizado' } }),
    'ENROLLMENT_CLOSED',
  );
  throwsCode(
    () => evaluarInscripcionGratuita({ ...base, confirmedCount: 8 }),
    'TOURNAMENT_FULL',
  );
  assert.deepEqual(
    evaluarInscripcionGratuita({
      ...base,
      confirmedCount: 8,
      equipo: { ...base.equipo, inscripcion_estado: 'confirmado' },
    }),
    { ok: true, gratis: true, already: true },
  );
  assert.deepEqual(
    evaluarInscripcionGratuita({ ...base, torneo: { ...base.torneo, estado: 'ABIERTO' } }),
    { ok: true, gratis: true, already: false },
  );
});
