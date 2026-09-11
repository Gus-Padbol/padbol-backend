import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture, run, userId, configured } from './fixtures/incentivesV4Fixture.js';
import { FOUR_GOAL_RULES, INCENTIVE_RULES_VERSION } from './sedeIncentivesV4.js';
import { ensureReservaPendienteParaMpPg, normalizeCrearPreferenciaReservaInput } from '../routes/reservaPendienteMp.js';
import { buildReservaInsertRow } from '../routes/partidos.js';

test('12 reservas completadas: 10 y 11 no cumplen; 12 sí, sin exigir porcentaje general de marcador', async () => {
  assert.equal(FOUR_GOAL_RULES.resultados_registrados_porcentaje_minimo, 100);
  assert(!Object.hasOwn(FOUR_GOAL_RULES, 'partidos_marcador_porcentaje_minimo'));
  for (const n of [10, 11, 12]) {
    const t = fixture({ digitalMatches: 8 }); t.reservas = t.reservas.slice(0, n);
    const { result } = await run(t);
    assert.equal(result.metrics.reservas_validas, n);
    assert.equal(result.evaluation.detalle_criterios.reservas.target, 12);
    assert.equal(result.evaluation.cumplido, n === 12);
    assert.equal(result.commercial_status.projected_monthly_usd, n === 12 ? 17 : null);
    assert.equal(result.commercial_status.billing_enabled, false);
  }
});
test('sólo la final requiere marcador: los demás resultados pueden ser todos manuales', async () => {
  for (const playedMatches of [7,15]) {
    const { result } = await run(fixture({ playedMatches, digitalMatches: 1 }));
    assert.equal(result.evidence[0].partidos_jugados_sincronizados, 1);
    assert.equal(result.evidence[0].todos_resultados_registrados, true);
    assert.equal(result.evidence[0].final_marcador_verificado, true);
    assert.equal(result.evaluation.criterios.resultados, true);
    assert.equal(result.evaluation.criterios.torneos_integrales, true);
    assert.equal(result.evaluation.cumplido, true);
  }
});
test('final manual o sin evidencia de punto no acredita el cierre aunque todos los resultados estén registrados', async () => {
  for (const digital of [0,1]) {
    const t=fixture({ digitalMatches:digital }); t.scoreboard_historial_puntos=[];
    const { result }=await run(t);
    assert.equal(result.evaluation.criterios.resultados,true);
    assert.equal(result.evaluation.criterios.torneos_integrales,false);
    assert.equal(result.evaluation.cumplido,false);
    assert.equal(result.commercial_status.projected_monthly_usd,null);
  }
});
test('un punto arbitrario no sustituye el último punto que produce el campeón', async () => {
  for (const mutate of [
    point => { point.score_a_antes=30; },
    point => { point.sets_a_antes=0; },
    point => { point.estado_antes='terminado'; },
    point => { point.historial_sets_antes=[]; },
    point => { point.historial_sets_antes[0].b=0; },
  ]) {
    const t=fixture({digitalMatches:1}); mutate(t.scoreboard_historial_puntos[0]);
    const {result}=await run(t);
    assert.equal(result.evidence[0].partidos_jugados_sincronizados,1);
    assert.equal(result.evidence[0].final_marcador_verificado,false);
    assert.equal(result.evaluation.criterios.resultados,true);
    assert.equal(result.evaluation.criterios.torneos_integrales,false);
    assert.equal(result.evaluation.cumplido,false);
  }
});
test('la final digital no compensa un resultado manual faltante ni las otras metas', async () => {
  const t=fixture({digitalMatches:1});t.partidos[0].resultado=null;
  const result=(await run(t)).result;
  assert.equal(result.evaluation.cumplido,false);
  assert.equal(result.evaluation.criterios.resultados,false);
  const onlyTournament=fixture({digitalMatches:1});onlyTournament.reservas=[];
  const partial=(await run(onlyTournament)).result;
  assert.equal(partial.evaluation.criterios.torneos_integrales,true);
  assert.equal(partial.evaluation.criterios.reservas,false);
  assert.equal(partial.commercial_status.projected_monthly_usd,null);
});
test('parejas usan cuentas reales: perfil huérfano no acredita inscripción y no se exige pago', async () => {
  const t=fixture({digitalMatches:1});t.torneos[0].costo_inscripcion=0;
  const full=(await run(t)).result;
  assert.equal(full.evaluation.cumplido,true);
  const orphan=(await run(t,{missingUsers:new Set([userId(16)])})).result;
  assert.equal(orphan.evidence[0].parejas_confirmadas,7);
  assert.equal(orphan.evaluation.criterios.torneos_integrales,false);
});
test('el contrato anterior de diez reservas no se reinterpreta como aprobado', async () => {
  const { result } = await run(fixture(), {}, { ...configured,
    reglas_version: 'activity-v4-four-goals-scoreboard-half',
    configuracion: { ...FOUR_GOAL_RULES, reservas_completadas_minimas: 10 } });
  assert.equal(result.requires_rules_migration, true);
  assert.equal(result.evaluation.cumplido, null);
  assert.notEqual(INCENTIVE_RULES_VERSION, 'activity-v4-four-goals-scoreboard-half');
});
test('ocho parejas inscritas con estado finalizado no sustituyen la actividad y cierre real', async () => {
  for (const mutation of [
    t => { t.partidos = []; },
    t => { t.partidos = t.partidos.slice(0, 1); },
    t => { t.partidos = t.partidos.slice(0, 4); },
    t => { t.partidos.at(-1).estado = 'pendiente'; t.partidos.at(-1).resultado = null; },
    t => { t.torneos[0].estado = 'en_curso'; },
    t => { t.torneos[0].fecha_fin = '2026-10-04'; },
  ]) {
    const t = fixture(); mutation(t);
    assert.equal((await run(t)).result.metrics.torneos_integrales_validos, 0);
  }
});
test('cuadro sin final, roto o sin metadatos nunca acredita torneo finalizado', async () => {
  for (const mutate of [
    t => { t.partidos = t.partidos.slice(0, 4); },
    t => { t.partidos.pop(); },
    t => { t.partidos[0].partido_siguiente_id = 99999; },
    t => { t.partidos[0].partido_siguiente_slot = 'B'; },
    t => { t.partidos[0].bracket_position = 2; },
    t => { t.torneos[0].tipo_torneo = 'liga_legacy'; },
  ]) {
    const t = fixture({ playedMatches: 7 }); mutate(t);
    const { result } = await run(t);
    assert.equal(result.metrics.torneos_integrales_validos, 0);
    assert.equal(result.evidence[0].cierre.verified, false);
    assert.equal(result.commercial_status.projected_monthly_usd, null);
  }
  for (const playedMatches of [7, 15]) {
    const { result } = await run(fixture({ playedMatches }));
    assert.equal(result.evidence[0].cierre.verified, true);
    assert.equal(result.evidence[0].cierre.ganador_equipo_id, 1);
  }
});
test('participantes con actividad fechada cuentan aunque no exista un alta de vínculo nueva', async () => {
  const t = fixture(); t.sede_jugadores = []; t.reservas = [];
  const { result } = await run(t);
  assert.equal(result.metrics.jugadores_activos, 16);
  assert.equal(result.evidence[0].parejas_con_actividad, 8);
  assert.equal(result.metrics.torneos_integrales_validos, 1);
  assert.equal(result.metrics.torneos_resultados_completos, 1);
});
test('deduplicación mensual une actividad de torneo y reservas, sin sumar inscripciones inactivas', async () => {
  const t = fixture(); t.sede_jugadores = [];
  assert.equal((await run(t)).result.metrics.jugadores_activos, 16);
  t.reservas = []; t.partidos = t.partidos.slice(0, 1);
  assert.equal((await run(t)).result.metrics.jugadores_activos, 4);
  t.partidos = [];
  assert.equal((await run(t)).result.metrics.jugadores_activos, 0);
});
test('doce reservas del mismo usuario son doce reservas y sólo una persona activa', async () => {
  const t = fixture(); t.torneos = []; t.sede_jugadores = [];
  t.reservas.forEach(row => { row.user_id = userId(1); });
  const { result } = await run(t);
  assert.equal(result.metrics.reservas_validas, 12);
  assert.equal(result.metrics.jugadores_activos, 1);
  assert.equal(result.evaluation.criterios.jugadores_activos, false);
});
test('reservas históricas/manuales sin origen acreditado no se convierten en uso de app', async () => {
  for (const origin of [undefined, null, '', 'app', 'admin_manual', 'checkout_jugador_v1 ']) {
    const t = fixture(); t.torneos = [];
    t.reservas.forEach(row => { row.origen_creacion = origin; });
    const { result } = await run(t);
    assert.equal(result.metrics.reservas_validas, 0);
    assert.equal(result.metrics.jugadores_activos, 0);
    assert.equal(result.evidence_notes.reservas_reales_sin_origen_acreditado, 12);
  }
});
test('procedencia acreditada no sustituye asistencia, cuenta verificada ni sede correcta', async () => {
  for (const mutate of [
    t => { t.reservas[0].checkin_at = '2026-08-31T12:00:00Z'; },
    t => { t.reservas[0].sede_id = 8; },
    t => { t.reservas[0].estado = 'cancelada'; },
  ]) { const t = fixture(); mutate(t); assert.equal((await run(t)).result.metrics.reservas_validas, 11); }
  assert.equal((await run(fixture(), { unverified: new Set([userId(1)]) })).result.metrics.reservas_validas, 11);
  const t = fixture(); t.reservas.push({ ...t.reservas[0] });
  assert.equal((await run(t)).result.metrics.reservas_validas, 12);
});

const booking = { sede_id: 7, sede: 'Sede sintética', fecha: '2026-09-04', hora: '14:00',
  cancha_id: 1, email: 'fixture@example.invalid', duracion_minutos: 60 };
const authUser = { id: userId(1), email: booking.email };
const quote = { total: 100, moneda: 'ARS', pricing_snapshot: { fixture: true } };
function pgFixture(existing = null) {
  const queries = [];
  return { queries, async query(sql, params) {
    queries.push({ sql, params });
    if (/^\s*INSERT INTO reservas/.test(sql)) return { rows: [{ id: 42 }] };
    if (/SELECT id, estado, pago_estado, user_id, email/.test(sql)) return { rows: existing ? [existing] : [] };
    return { rows: [] };
  } };
}
test('checkout marca creación nueva en SQL y conserva actor/importe servidor sin confiar en body', async () => {
  for (const paymentProvider of ['mercadopago', 'stripe']) {
    const pg = pgFixture();
    const body = { reservaData: { ...booking, user_id: userId(999), origen_creacion: 'admin_manual' }, origen_creacion: 'app' };
    const result = await ensureReservaPendienteParaMpPg(pg, body, { authUser, quote, paymentProvider });
    assert.equal(result.created, true);
    const insert = pg.queries.find(q => /^\s*INSERT INTO reservas/.test(q.sql));
    assert.match(insert.sql, /user_id, origen_creacion/);
    assert.equal(insert.params.at(-1), 'checkout_jugador_v1');
    assert.equal(insert.params.at(-2), authUser.id);
    assert.equal(insert.params[13], 100);
    assert(!insert.params.includes('admin_manual'));
    assert(!Object.hasOwn(normalizeCrearPreferenciaReservaInput(body), 'origen_creacion'));
  }
});
test('pagar una reserva histórica existente no acredita origen ni añade un insert', async () => {
  const pg = pgFixture({ id: 42, estado: 'pendiente', pago_estado: 'pendiente', user_id: authUser.id, email: authUser.email });
  const result = await ensureReservaPendienteParaMpPg(pg, { reservaData: { ...booking, id: 42, origen_creacion: 'checkout_jugador_v1' } }, { authUser, quote, paymentProvider: 'stripe' });
  assert.equal(result.created, false);
  assert(pg.queries.every(q => !/origen_creacion|INSERT INTO reservas/.test(q.sql)));
});
test('constructor compartido manual conserva formato anterior y descarta origen del cliente', () => {
  const row = buildReservaInsertRow({ user_id: authUser.id, sedeId: 7, origen_creacion: 'checkout_jugador_v1' });
  assert(!Object.hasOwn(row, 'origen_creacion'));
});
test('escritor real de encuentro sella origen y propietario del contexto autenticado', async () => {
  const source = await readFile(new URL('../routes/partidos.js', import.meta.url), 'utf8');
  const start = source.indexOf('      const reservaInsert = buildReservaInsertRow({');
  const end = source.indexOf("      console.log('[DEBUG INSERT reservas]'", start);
  assert(start > 0 && end > start);
  const row = vm.runInNewContext(source.slice(start, end) + '\nreservaInsert;', {
    buildReservaInsertRow, sedeRow: { id: 7, nombre: 'Sede sintética' }, fecha: '2026-09-04', hora: '14:00',
    req: { body: { cancha_id: 1, origen_creacion: 'app', user_id: userId(999) } },
    canchaStorage: '1', courtContract: { canchaId: 701 }, contactNombre: 'fixture', contactEmail: authUser.email,
    contactWhatsapp: '', nivel: 'Principiante', totalPrecio: 100, durationMinutes: 60, user: authUser,
  });
  assert.equal(row.origen_creacion, 'encuentro_jugador_v1');
  assert.equal(row.user_id, authUser.id);
  assert.equal(row.sede_id, 7);
  assert.equal(row.cancha_id, 701);
  assert.equal(row.precio, 100);
});
