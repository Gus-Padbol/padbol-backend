import test from 'node:test';
import assert from 'node:assert/strict';
import {accesoPlantelesTorneo, esTorneoSelecciones} from './tournamentTeamsPrivacy.js';

const nations = {modalidad_plantel: 'selecciones', plan_nations: null, fecha_inicio: '2026-11-20', horas_revelar_equipos: 48};
const normal = {modalidad_plantel: 'equipos', plan_nations: null, fecha_inicio: '2026-11-20', horas_revelar_equipos: null};
const antes = new Date('2026-11-10T00:00:00Z');
const despues = new Date('2026-11-25T00:00:00Z');

test('selecciones con plan_nations NULL sigue siendo Nations (fail-closed)', () => {
  assert.equal(esTorneoSelecciones(nations), true);
});

test('anon no ve planteles aunque la fecha de revelación haya pasado sin aprobación', () => {
  assert.equal(accesoPlantelesTorneo({torneo: nations, event: {roster_publication_approved: false}, esAdmin: false, ahora: despues}).allowed, false);
});

test('anon no ve planteles antes de la revelación aunque esté aprobado', () => {
  assert.equal(accesoPlantelesTorneo({torneo: nations, event: {roster_publication_approved: true}, esAdmin: false, ahora: antes}).allowed, false);
});

test('tras revelación y aprobación, el público sí ve', () => {
  const r = accesoPlantelesTorneo({torneo: nations, event: {roster_publication_approved: true}, esAdmin: false, ahora: despues});
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'revealed');
});

test('admin y capitán siempre ven lo suyo', () => {
  assert.equal(accesoPlantelesTorneo({torneo: nations, event: {}, esAdmin: true, ahora: antes}).reason, 'admin');
  assert.equal(accesoPlantelesTorneo({torneo: nations, event: {}, esAdmin: false, captainIds: [7], ahora: antes}).reason, 'captain');
});

test('torneo normal no se bloquea', () => {
  assert.equal(accesoPlantelesTorneo({torneo: normal, event: null, esAdmin: false, ahora: antes}).allowed, true);
});
