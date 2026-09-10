import test from 'node:test';

import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

import path from 'node:path';

import { fileURLToPath } from 'node:url';

import {
  buildPadbolCourtProgramDraft,
  buildPadbolCourtCommercialStatus,
  evaluateIncentiveMetrics,
  monthPeriodBounds,
  normalizeIncentiveRules,
  padbolCourtProgramMonth,
  reconcileExpiredSedeIncentives,
} from './sedeIncentives.js';

const CONFIGURED_RULES = {
  torneos_minimos: 1,
  jugadores_registrados_minimos: 8,
  partidos_marcador_minimos: 3,
  reservas_minimas: 10,
  jugadores_activos_minimos: 10,
  movimientos_padcoins_minimos: 5,
};

test('sin decisión comercial no inventa objetivos ni metas numéricas', () => {
  assert.deepEqual(normalizeIncentiveRules({}), {});
  const result = evaluateIncentiveMetrics({ reservas_validas: 7 }, {});
  assert.equal(result.cumplido, null);
  assert.equal(result.configuracion_completa, false);
  assert.equal(result.detalle_criterios.reservas.current, 7);
  assert.equal(result.detalle_criterios.reservas.target, null);
  assert.equal(result.detalle_criterios.reservas.state, 'pending_configuration');
  assert.equal(result.objetivos_pendientes_configuracion.length, 6);
});

test('el descuento por objetivos sólo se proyecta si están todos configurados y cumplidos', () => {
  const result = evaluateIncentiveMetrics({
    torneos_finalizados: 1,
    jugadores_registrados_torneos: 8,
    partidos_marcador_finalizados: 3,
    reservas_validas: 10,
    jugadores_activos: 10,
    movimientos_padcoins: 5,
  }, CONFIGURED_RULES);
  assert.equal(result.cumplido, true);
  assert.equal(result.configuracion_completa, true);
  assert.equal(result.criterios.reservas, true);
});

test('con objetivos configurados muestra cuáles están cumplidos y cuáles pendientes', () => {
  const result = evaluateIncentiveMetrics({
    torneos_finalizados: 0,
    jugadores_registrados_torneos: 8,
    partidos_marcador_finalizados: 2,
    reservas_validas: 10,
    jugadores_activos: 10,
    movimientos_padcoins: 5,
  }, CONFIGURED_RULES);
  assert.equal(result.cumplido, false);
  assert.equal(result.criterios.torneos_integrales, false);
  assert.equal(result.criterios.reservas, true);
  assert.equal(result.detalle_criterios.marcador.state, 'pending');
  assert.equal(result.criterios_cumplidos, 4);
});

test('normaliza únicamente metas positivas explícitas', () => {
  const rules = normalizeIncentiveRules({ torneos_minimos: 2, reservas_minimas: -4, movimientos_padcoins_minimos: 0 });
  assert.equal(rules.torneos_minimos, 2);
  assert.equal(Object.hasOwn(rules, 'reservas_minimas'), false);
  assert.equal(Object.hasOwn(rules, 'movimientos_padcoins_minimos'), false);
});

test('período mensual usa límites UTC estables', () => {
  assert.deepEqual(monthPeriodBounds('2026-09-18'), {
    period: '2026-09-01',
    startDate: '2026-09-01',
    endDate: '2026-10-01',
    startIso: '2026-09-01T00:00:00.000Z',
    endIso: '2026-10-01T00:00:00.000Z',
  });
});

test('calcula el mes comercial por calendario desde la fecha de inicio', () => {
  assert.equal(padbolCourtProgramMonth('2026-01-15', '2026-01-31'), 1);
  assert.equal(padbolCourtProgramMonth('2026-01-15', '2026-04-01'), 4);
  assert.equal(padbolCourtProgramMonth('', '2026-04-01'), null);
});

test('expone las tarifas confirmadas sin habilitar facturación', () => {
  const included = buildPadbolCourtCommercialStatus({
    fechaInicio: '2026-01-15',
    period: '2026-03-10',
    evaluation: { configuracion_completa: false, cumplido: null },
  });
  assert.equal(included.program_month, 3);
  assert.equal(included.projected_monthly_usd, 0);
  assert.equal(included.billing_enabled, false);

  const pending = buildPadbolCourtCommercialStatus({
    fechaInicio: '2026-01-15',
    period: '2026-04-10',
    evaluation: { configuracion_completa: false, cumplido: null },
  });
  assert.equal(pending.base_monthly_usd, 68);
  assert.equal(pending.reference_monthly_usd, 34);
  assert.equal(pending.potential_monthly_usd, 17);
  assert.equal(pending.projected_monthly_usd, null);
  assert.equal(pending.phase, 'objectives_configuration_pending');

  const completed = buildPadbolCourtCommercialStatus({
    fechaInicio: '2026-01-15',
    period: '2026-04-10',
    evaluation: { configuracion_completa: true, cumplido: true },
  });
  assert.equal(completed.projected_monthly_usd, 17);
});

test('crear una ficha genera sólo un borrador de tres meses y sin metas implícitas', () => {
  const draft = buildPadbolCourtProgramDraft({
    sedeId: 7,
    start: '2026-09-09',
    rules: {},
    now: new Date('2026-09-09T15:00:00Z'),
  });
  assert.equal(draft.estado, 'borrador');
  assert.equal(draft.meses_base, 3);
  assert.equal(draft.fecha_fin_base, null);
  assert.equal(Object.hasOwn(draft, 'beneficio_hasta'), false);
  assert.equal(draft.reglas_version, 'pricing-v2-pending-objectives');
  assert.deepEqual(draft.configuracion, {});
});

test('la reconciliación comercial anterior queda bloqueada', async () => {
  let rpcCalled = false;
  const supabase = { rpc: async () => { rpcCalled = true; } };

  await assert.rejects(
    reconcileExpiredSedeIncentives(supabase, new Date('2026-09-04T18:30:00Z')),
    (error) => error.code === 'LEGACY_INCENTIVE_RECONCILIATION_DISABLED',
  );
  assert.equal(rpcCalled, false);
});
