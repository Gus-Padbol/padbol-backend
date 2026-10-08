import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOUR_GOAL_RULES, INCENTIVE_RULES_VERSION, buildPadbolCourtProgramDraft,
  buildPadbolCourtCommercialStatus, evaluateIncentiveMetrics, monthPeriodBounds,
  normalizeIncentiveRules, padbolCourtProgramMonth, reconcileExpiredSedeIncentives,
  evaluateSedeIncentive, registerSedeIncentiveRoutes,
} from './sedeIncentivesV4.js';

import { fixture, client, run, userId, timestamp, period, configured, LEGACY_RULES, completeMetrics } from './fixtures/incentivesV4Fixture.js';

test('cuatro criterios explícitos, sin PadCoins ni conversión del esquema legado', () => {
  assert.deepEqual(normalizeIncentiveRules(LEGACY_RULES), {});
  assert.deepEqual(normalizeIncentiveRules({}), {});
  assert.deepEqual(normalizeIncentiveRules(FOUR_GOAL_RULES), FOUR_GOAL_RULES);
  const evaluation = evaluateIncentiveMetrics(completeMetrics, LEGACY_RULES);
  assert.equal(evaluation.criterios_requeridos, 4);
  assert.equal(evaluation.cumplido, null);
  assert.equal(evaluation.configuracion_completa, false);
  assert(!Object.hasOwn(evaluation.criterios, 'padcoins'));
});
test('metas autorizadas no admiten strings truncados ni umbrales reinterpretados', () => {
  for (const value of ['8 jugadores', '8', 8.5, 4, null, true]) {
    const rules = normalizeIncentiveRules({ ...FOUR_GOAL_RULES, parejas_confirmadas_por_torneo_minimas: value });
    assert(!Object.hasOwn(rules, 'parejas_confirmadas_por_torneo_minimas'));
  }
  assert(!Object.hasOwn(normalizeIncentiveRules({ ...FOUR_GOAL_RULES, resultados_registrados_porcentaje_minimo: 49 }), 'resultados_registrados_porcentaje_minimo'));
  assert(!Object.hasOwn(FOUR_GOAL_RULES, 'partidos_marcador_por_torneo_minimos')); // Historical fixed-minimum key stays obsolete.
});
test('requiere las cuatro metas y conserva datos faltantes como no disponibles', () => {
  assert.equal(evaluateIncentiveMetrics(completeMetrics, FOUR_GOAL_RULES).cumplido, true);
  const partial = evaluateIncentiveMetrics({ ...completeMetrics, reservas_validas: 9 }, FOUR_GOAL_RULES);
  assert.equal(partial.cumplido, false);
  assert.equal(partial.criterios_cumplidos, 3);
  for (const value of [null, undefined, '', '10', NaN]) {
    const missing = evaluateIncentiveMetrics({ ...completeMetrics, reservas_validas: value }, FOUR_GOAL_RULES);
    assert.equal(missing.cumplido, null);
    assert.equal(missing.detalle_criterios.reservas.state, 'unavailable');
  }
});
test('periodo mensual y mes comercial conservan límites UTC', () => {
  assert.deepEqual(monthPeriodBounds('2026-09-18'), { period, startDate: period, endDate: '2026-10-01', startIso: '2026-09-01T00:00:00.000Z', endIso: '2026-10-01T00:00:00.000Z' });
  assert.equal(padbolCourtProgramMonth('2026-01-15', '2026-01-31'), 1);
  assert.equal(padbolCourtProgramMonth('2026-01-15', '2026-04-01'), 4);
});
test('los borradores requieren versión explícita y nunca activan facturación', () => {
  const old = buildPadbolCourtProgramDraft({ sedeId: 7, start: period, rules: LEGACY_RULES, rulesVersion: 'pricing-v2' });
  assert.deepEqual(old.configuracion, {});
  assert.equal(old.reglas_version, `${INCENTIVE_RULES_VERSION}-pending-objectives`);
  const next = buildPadbolCourtProgramDraft({ sedeId: 7, start: period, rules: FOUR_GOAL_RULES, rulesVersion: INCENTIVE_RULES_VERSION });
  assert.equal(next.reglas_version, INCENTIVE_RULES_VERSION);
  assert.equal(next.estado, 'borrador'); assert.equal(next.meses_base, 3); assert.equal(next.fecha_fin_base, null);
});
test('tarifas exclusivas Padbol conservan 68/34/17 y no acumulan descuentos', () => {
  const evaluation = evaluateIncentiveMetrics({ ...completeMetrics, torneos_integrales_validos: 100, torneos_resultados_completos: 100 }, FOUR_GOAL_RULES);
  const status = buildPadbolCourtCommercialStatus({ fechaInicio: '2026-01-01', period, evaluation, venueScope: 'padbol_only' });
  assert.equal(status.base_monthly_usd, 68); assert.equal(status.reference_monthly_usd, 34); assert.equal(status.projected_monthly_usd, 17); assert.equal(status.billing_enabled, false);
  assert.equal(buildPadbolCourtCommercialStatus({ fechaInicio: '2026-08-01', period, venueScope: 'padbol_only' }).projected_monthly_usd, 0);
});
test('club mixto o alcance no comprobado no recibe cotización 34/17 global', () => {
  for (const venueScope of ['mixed', 'unknown', 'non_padbol']) {
    const status = buildPadbolCourtCommercialStatus({ fechaInicio: '2026-01-01', period, venueScope, evaluation: { configuracion_completa: true, cumplido: true } });
    assert.equal(status.projected_monthly_usd, null); assert.equal(status.reference_monthly_usd, null); assert.equal(status.potential_monthly_usd, null);
    assert.equal(status.objectives_monthly_usd, null); assert.equal(status.billing_enabled, false);
  }
});
test('fixture de esquema real cumple sin movimientos PadCoins y sin escrituras', async () => {
  const { result } = await run();
  assert.deepEqual(result.metrics, completeMetrics);
  assert.equal(result.evaluation.cumplido, true); assert.equal(result.evaluation.criterios_requeridos, 4);
  assert.equal(result.commercial_status.projected_monthly_usd, 17); assert.equal(result.credito_otorgado, false); assert.equal(result.persisted, false);
  assert.equal(result.evidence[0].parejas_confirmadas, 8); assert.equal(result.evidence[0].jugadores_distintos, 16);
});
test('resultado manual sin fecha fiable cuenta en resultados, no inventa actividad mensual', async () => {
  const tables = fixture({ digitalMatches: 0 }); tables.reservas = [];
  const { result } = await run(tables);
  assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(result.evidence[0].todos_resultados_registrados, true);
  assert.equal(result.evidence[0].partidos_jugados_sincronizados, 0);
  assert.equal(result.metrics.jugadores_activos, 0);
  assert.equal(result.metrics.torneos_resultados_completos, 1);
});
test('forma del servicio manual admin tampoco implica uso del marcador', async () => {
  const tables = fixture({ digitalMatches: 0 }); tables.reservas = [];
  tables.partidos.forEach((row) => {
    row.resultado = { goles_a: 2, goles_b: 0, fuente_resultado: 'manual_admin' };
    row.ganador_equipo_id = row.equipo_a_id;
  });
  const { result } = await run(tables);
  assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(result.evidence[0].partidos_jugados_sincronizados, 0);
  assert.equal(result.metrics.jugadores_activos, 0);
});
test('carga manual con historial y fila de scoreboard recién creada sigue sin acreditar uso digital', async () => {
  const tables = fixture(); tables.scoreboard_historial_puntos = []; tables.reservas = [];
  tables.partidos.forEach((row, index) => {
    row.resultado = { goles_a: 2, goles_b: 0, fuente_resultado: 'manual_admin',
      historial_sets: structuredClone(tables.scoreboard_partidos[index].historial_sets) };
  });
  const { result } = await run(tables);
  assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(result.evidence[0].partidos_jugados_sincronizados, 0);
  assert.equal(result.metrics.jugadores_activos, 0);
  assert.equal(result.metrics.torneos_resultados_completos, 1);
});
test('resultado manual de tres sets acepta ganador B con identidad coherente', async () => {
  const tables = fixture({ digitalMatches: 8 });
  const match = tables.partidos[8];
  match.resultado = JSON.stringify({ set1: '6-3', set2: '5-7', set3: '4-6', ganador_id: match.equipo_b_id });
  const { result } = await run(tables);
  assert.equal(result.evidence[0].todos_resultados_registrados, true);
  assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(result.evidence[0].partidos_jugados_sincronizados, 8);
  assert.equal(result.evaluation.cumplido, true);
});
test('resultado manual incompleto, sets imposibles o ganador inconsistente impiden completar todos los resultados', async () => {
  for (const payload of [
    { set1: '6-3', set2: '', ganador_id: 5 },
    { set1: '6-3', set2: '6-4', set3: '6-2', ganador_id: 5 },
    { set1: '6-6', set2: '6-4', ganador_id: 5 },
    { set1: '6-3', set2: '6-4', ganador_id: 8 },
    { set1: '6-3', set2: '6-4' },
  ]) {
    const tables = fixture({ digitalMatches: 8 });
    tables.partidos[8].resultado = JSON.stringify(payload);
    const { result } = await run(tables);
    assert.equal(result.evidence[0].todos_resultados_registrados, false);
    assert.equal(result.metrics.torneos_resultados_completos, 0);
  }
});
test('las mismas ocho parejas pueden cumplir en dos meses sin sumar jugadores nuevos', async () => {
  const tables = fixture({ digitalMatches: 8 });
  const followingMonth = structuredClone(tables);
  followingMonth.torneos[0] = { ...followingMonth.torneos[0], id: 202, fecha_fin: '2026-10-04' };
  followingMonth.equipos.forEach((row) => { row.id += 100; row.torneo_id = 202; });
  followingMonth.partidos.forEach((row) => {
    row.id += 10000; row.torneo_id = 202;
    if (row.partido_siguiente_id != null) row.partido_siguiente_id += 10000;
    row.equipo_a_id += 100; row.equipo_b_id += 100;
    if (row.ganador_equipo_id != null) row.ganador_equipo_id += 100;
    if (typeof row.resultado === 'string') {
      const result = JSON.parse(row.resultado); result.ganador_id += 100;
      row.resultado = JSON.stringify(result);
    }
  });
  followingMonth.scoreboard_partidos.forEach((row, index) => {
    row.id = userId(100001 + index); row.torneo_id = 202; row.partido_torneo_id += 10000;
    row.synced_to_torneo_at = '2026-10-04T15:00:00.000Z'; row.updated_at = row.synced_to_torneo_at;
  });
  followingMonth.scoreboard_historial_puntos.forEach((row, index) => {
    row.id = userId(200001 + index); row.partido_id = followingMonth.scoreboard_partidos[index].id;
    row.timestamp = '2026-10-04T14:59:00.000Z';
  });
  followingMonth.reservas.forEach((row) => {
    row.id += 1000; row.fecha = '2026-10-04'; row.checkin_at = '2026-10-04T15:00:00.000Z';
  });
  for (const name of ['torneos', 'equipos', 'partidos', 'scoreboard_partidos', 'scoreboard_historial_puntos', 'reservas']) {
    tables[name].push(...followingMonth[name]);
  }
  assert.deepEqual(tables.jugadores_perfil, followingMonth.jugadores_perfil);
  assert.deepEqual(tables.sede_jugadores, followingMonth.sede_jugadores);
  for (const [requestedPeriod, tournamentId] of [[period, 101], ['2026-10-01', 202]]) {
    const { result } = await run(tables, {}, configured, requestedPeriod);
    assert.deepEqual(result.metrics, completeMetrics);
    assert.equal(result.evaluation.cumplido, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].torneo_id, tournamentId);
    assert.equal(result.evidence[0].parejas_confirmadas, 8);
    assert.equal(result.evidence[0].partidos_jugados_sincronizados, 8);
    assert.equal(result.commercial_status.projected_monthly_usd, 17);
  }
});
test('ocho jugadores entre cuatro parejas no se convierten en ocho parejas', async () => {
  const tables = fixture(); tables.equipos = tables.equipos.slice(0, 4);
  const { result } = await run(tables); assert.equal(result.metrics.torneos_integrales_validos, 0); assert.equal(result.evaluation.cumplido, false);
});
test('dos torneos con cuatro parejas cada uno no suman una meta integral', async () => {
  const tables = fixture(); tables.torneos.push({ ...tables.torneos[0], id: 102 });
  tables.equipos.slice(4).forEach((row) => { row.torneo_id = 102; });
  const { result } = await run(tables); assert.equal(result.metrics.torneos_integrales_validos, 0);
});
test('parejas repetidas, jugadores repetidos y registros sin confirmar no califican', async () => {
  for (const mutate of [
    (t) => { t.equipos[7].jugadores[1].user_id = userId(1); },
    (t) => { t.equipos[7].jugadores[1].user_id = userId(15); },
    (t) => { t.equipos[7].inscripcion_estado = 'pendiente'; },
    (t) => { t.equipos[7].jugadores = [{ nombre: 'Invitado' }, { nombre: 'Invitado' }]; },
    (t) => { t.jugadores_perfil.pop(); },
  ]) { const tables = fixture(); mutate(tables); const { result } = await run(tables); assert.equal(result.metrics.torneos_integrales_validos, 0); }
});
test('duplicar el mismo partido o marcador no convierte siete usos digitales en ocho', async () => {
  const tables = fixture({ digitalMatches: 7 });
  tables.partidos.push({ ...tables.partidos[0] });
  tables.scoreboard_partidos.push({ ...tables.scoreboard_partidos[0], id: userId(7777) });
  tables.scoreboard_historial_puntos.push({ ...tables.scoreboard_historial_puntos[0], id: userId(7778), partido_id: userId(7777) });
  const { result } = await run(tables);
  assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(result.evidence[0].partidos_jugados_sincronizados, 7);
  assert.equal(result.metrics.torneos_resultados_completos, 1);
});
test('no mezcla marcadores de otro torneo o sede', async () => {
  for (const field of ['torneo_id', 'sede_id']) { const tables = fixture({ digitalMatches: 8 }); tables.scoreboard_partidos[0][field] = 999; const { result } = await run(tables); assert.equal(result.evidence[0].partidos_jugados_sincronizados, 7); }
});
test('sincronización fallida, resultado divergente o ganador incorrecto no cuentan', async () => {
  for (const mutate of [
    (t) => { t.scoreboard_partidos[0].sync_torneo_status = 'failed'; },
    (t) => { t.scoreboard_partidos[0].synced_to_torneo_at = null; },
    (t) => { t.partidos[0].resultado = { goles_a: 2, goles_b: 1 }; },
    (t) => { t.partidos[0].ganador_equipo_id = 2; },
    (t) => { t.partidos[0].estado = 'pendiente'; },
  ]) { const tables = fixture({ digitalMatches: 8 }); mutate(tables); const { result } = await run(tables); assert.equal(result.evidence[0].partidos_jugados_sincronizados, 7);  }
});
test('marcador reabierto no reutiliza la fila final anterior', async () => {
  const tables = fixture({ digitalMatches: 8 }); tables.scoreboard_partidos.push({ ...tables.scoreboard_partidos[0], id: userId(8888), estado: 'en_curso', updated_at: '2026-09-05T00:00:00Z' });
  const { result } = await run(tables); assert.equal(result.evidence[0].partidos_jugados_sincronizados, 7);
});
test('una fila final arbitraria sin sets jugados y puntos no prueba juego real', async () => {
  for (const mutate of [
    (t) => { t.scoreboard_partidos[0].historial_sets = []; },
    (t) => { t.scoreboard_historial_puntos = t.scoreboard_historial_puntos.slice(1); },
    (t) => { t.scoreboard_partidos[0].historial_sets[0] = { set: 1, a: 0, b: 0 }; },
  ]) { const tables = fixture({ digitalMatches: 8 }); mutate(tables); const { result } = await run(tables); assert.equal(result.evidence[0].partidos_jugados_sincronizados, 7); }
});
test('cancelaciones y WO no cuentan como juego y una final sin jugar no acredita cierre', async () => {
  for (const excludedIndex of [0, 14]) {
    for (const kind of ['cancelado', 'walkover', 'WO']) {
      const tables = fixture({ digitalMatches: excludedIndex === 0 ? 8 : 7 });
      const row = tables.partidos[excludedIndex];
      if (kind === 'cancelado') row.estado = kind;
      else row.resultado = { goles_a: 2, goles_b: 0, fuente_resultado: kind };
      const { result } = await run(tables);
      const evidence = result.evidence[0];
      assert.equal(evidence.partidos_requeridos, 14);
      assert.equal(evidence.partidos_jugados_resultado_registrado, 14);
      assert.equal(Object.hasOwn(evidence, 'partidos_marcador_requeridos'), false);
      assert.equal(evidence.partidos_jugados_sincronizados, excludedIndex === 0 ? 7 : 6);
      assert.equal(result.evaluation.cumplido, excludedIndex !== 14);
    }
  }
});
test('sin partidos jugados no existe cumplimiento por un denominador cero', async () => {
  for (const empty of [false, true]) {
    const tables = fixture(); tables.reservas = [];
    if (empty) tables.partidos = [];
    else tables.partidos.forEach((row) => { row.resultado.fuente_resultado = 'walkover'; });
    const { result } = await run(tables);
    assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 0);
    assert.equal(result.evidence[0].partidos_jugados_sincronizados, 0);
    assert.equal(result.metrics.jugadores_activos, 0);
    assert.equal(result.metrics.torneos_resultados_completos, 0);
  }
});
test('quince partidos no compensan otro partido pendiente del mismo torneo', async () => {
  const tables = fixture(); tables.partidos.push({ ...tables.partidos[0], id: 1016, estado: 'pendiente', resultado: null });
  const { result } = await run(tables); assert.equal(result.evidence[0].partidos_jugados_sincronizados, 15); assert.equal(result.evidence[0].partidos_requeridos, 16); assert.equal(result.metrics.torneos_resultados_completos, 0);
});
test('reservas se cuentan por fecha de realización, no por created_at', async () => {
  const tables = fixture(); const { result } = await run(tables); assert.equal(result.metrics.reservas_validas, 12);
  tables.reservas[0].fecha = '2026-10-04'; tables.reservas[0].created_at = timestamp;
  assert.equal((await run(tables)).result.metrics.reservas_validas, 11);
});
test('reservas pendientes, canceladas, sin asistencia o sin cuenta verificada quedan fuera', async () => {
  for (const mutate of [
    (t) => { t.reservas[0].estado = 'confirmada'; },
    (t) => { t.reservas[0].estado = 'cancelada'; },
    (t) => { t.reservas[0].checkin_realizado = false; },
    (t) => { t.reservas[0].checkin_at = null; },
    (t) => { t.reservas[0].deporte = 'padel'; },
  ]) { const tables = fixture(); mutate(tables); assert.equal((await run(tables)).result.metrics.reservas_validas, 11); }
  assert.equal((await run(fixture(), { unverified: new Set([userId(1)]) })).result.metrics.reservas_validas, 11);
});
test('jugadores vinculados e inscritos sin resultados ni reservas no cuentan como activos', async () => {
  const tables = fixture(); tables.reservas = []; tables.scoreboard_historial_puntos = [];
  tables.partidos.forEach((row) => { row.estado = 'pendiente'; row.resultado = null; });
  const { result } = await run(tables); assert.equal(result.metrics.jugadores_activos, 0);
});
test('puntos de otro mes conservan resultados pero no trasladan actividad al mes de cierre', async () => {
  const tables = fixture(); tables.reservas = [];
  tables.scoreboard_historial_puntos.forEach((row) => { row.timestamp = '2026-08-31T14:59:00Z'; });
  const { result } = await run(tables);
  assert.equal(result.metrics.jugadores_activos, 0);
  assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(result.metrics.torneos_resultados_completos, 1);
});
test('paginación procesa más de mil reservas y deduplica el usuario activo', async () => {
  const tables = fixture(); tables.reservas = Array.from({ length: 1005 }, (_, i) => ({ ...tables.reservas[0], id: i + 1 }));
  tables.torneos = []; const { result, supabase } = await run(tables);
  assert.equal(result.metrics.reservas_validas, 1005); assert.equal(result.metrics.jugadores_activos, 1);
  assert(supabase.requests.some((row) => row.table === 'reservas' && row.range[0] === 1000));
});
test('el fallo de consulta o verificación nunca se transforma en una meta cumplida', async () => {
  const unavailable = (await run(fixture(), { failTable: 'scoreboard_historial_puntos' })).result;
  assert.equal(unavailable.metrics.torneos_integrales_validos, null);
  assert.equal(unavailable.metrics.torneos_resultados_completos, 1);
  await assert.rejects(run(fixture(), { missingAuth: true }), { code: 'ACCOUNT_VERIFICATION_UNAVAILABLE' });
});
test('programa legado conserva bloqueo aun con actividad nueva suficiente', async () => {
  const { result } = await run(fixture(), {}, { ...configured, reglas_version: 'pricing-v2', configuracion: LEGACY_RULES });
  assert.equal(result.requires_rules_migration, true); assert.equal(result.evaluation.cumplido, null); assert.equal(result.commercial_status.projected_monthly_usd, null);
});
test('club mixto detectado por canchas conserva actividad sin asignar precio global', async () => {
  const tables = fixture(); tables.canchas.push({ id: 2, sede_id: 7, estado: 'activa', deporte: 'padel' });
  const { result } = await run(tables); assert.equal(result.evaluation.cumplido, true); assert.equal(result.commercial_status.phase, 'mixed_quote_pending'); assert.equal(result.commercial_status.projected_monthly_usd, null);
});
test('PATCH exige nueva versión explícita y no permite activar cobros', async () => {
  const handlers = new Map(); const app = { get(){}, post(){}, patch(path, handler) { handlers.set(path, handler); } };
  let writes = 0;
  registerSedeIncentiveRoutes(app, { supabase: { from() { writes += 1; throw new Error('Unexpected DB access'); } }, assertSuperAdminReq: async () => {} });
  for (const body of [
    { configuracion: LEGACY_RULES },
    { configuracion: FOUR_GOAL_RULES, reglas_version: 'pricing-v2' },
    { configuracion: FOUR_GOAL_RULES, reglas_version: INCENTIVE_RULES_VERSION, estado: 'activo' },
  ]) {
    const response = { status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
    await handlers.get('/api/admin/incentivos/:sedeId')({ params: { sedeId: '7' }, body }, response);
    assert.equal(response.statusCode, 409);
  }
  assert.equal(writes, 0);
});
test('la reconciliación comercial legada permanece deshabilitada', async () => {
  await assert.rejects(reconcileExpiredSedeIncentives(), { code: 'LEGACY_INCENTIVE_RECONCILIATION_DISABLED' });
});
