import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findSedeDuplicateCandidates, findDurationDuplicateCandidates,
  findExpiredTournamentCandidates, findMembershipPlanCandidates, validateMutationRequest,
} from './adminDataRemediation.js';

test('S-01 detecta nombres equivalentes sin decidir una fusión', () => {
  const result = findSedeDuplicateCandidates([{ id: 1, nombre: 'La Meca' }, { id: 2, nombre: 'La Meca Padbol Club' }]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].matches.map((row) => row.id), [1, 2]);
});

test('S-03 detecta duración/deporte activos duplicados', () => {
  const result = findDurationDuplicateCandidates([
    { id: 1, sede_id: 7, duracion_minutos: 60, deporte: 'padbol', precio: 20000, activo: true },
    { id: 2, sede_id: 7, duracion_minutos: 60, deporte: 'Padbol', precio: 26000, activo: true },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].prices, [20000, 26000]);
});

test('ME-01 y T-02 detectan inconsistencias relativas a una fecha estable', () => {
  const now = new Date('2026-10-07T00:00:00Z');
  assert.equal(findMembershipPlanCandidates([{ id: 3, activo: true, vigencia_hasta: '2026-09-05', sede_pais: 'Argentina', moneda: 'USD' }], now).length, 1);
  assert.equal(findExpiredTournamentCandidates([{ id: 4, estado: 'En curso', fecha_fin: '2026-07-30' }], now).length, 1);
});

test('mutación exige ID, confirmación idéntica y valores autorizados', () => {
  assert.equal(validateMutationRequest({ finding: 'T-02' }).error, 'id_explicito_requerido');
  assert.equal(validateMutationRequest({ finding: 'T-02', id: 4, confirmId: 5, fields: { estado: 'finalizado' } }).error, 'confirm_id_debe_coincidir');
  assert.equal(validateMutationRequest({ finding: 'T-02', id: 4, confirmId: 4, fields: { nombre: 'x' } }).error, 'campo_no_permitido');
  assert.deepEqual(validateMutationRequest({ finding: 'T-02', id: 4, confirmId: 4, fields: { estado: 'finalizado' } }), { ok: true, fields: { estado: 'finalizado' } });
  assert.equal(validateMutationRequest({ finding: 'G-06', id: 'x', confirmId: 'x', deleteRow: true }).ok, true);
  assert.equal(validateMutationRequest({ finding: 'S-01', id: 1, confirmId: 1, fields: { activo: false } }).error, 'fusion_sede_requiere_transaccion_humana');
});
