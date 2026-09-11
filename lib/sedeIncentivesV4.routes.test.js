import test from 'node:test';
import assert from 'node:assert/strict';
import { FOUR_GOAL_RULES, INCENTIVE_RULES_VERSION, monthPeriodBounds } from './sedeIncentivesV4.js';
import { configured, LEGACY_RULES, fixture } from './fixtures/incentivesV4Fixture.js';
import { routeFixture } from './fixtures/incentivesV4RoutesFixture.js';

const path = '/api/admin/incentivos';
const body = { reglas_version: INCENTIVE_RULES_VERSION, configuracion: FOUR_GOAL_RULES };
const legacy = { ...configured, estado: 'borrador', codigo: 'padbol_pro_renovable', reglas_version: 'pricing-v2', configuracion: LEGACY_RULES };

test('meses inválidos no se normalizan a otro período silenciosamente', () => {
  for (const value of ['2026-02-31', '2026-13-01', '2026-09-01garbage', '2026-09', '', {}, [], true, '2026-09-01T00:00:00Z']) assert.throws(() => monthPeriodBounds(value), { status: 400 });
  assert.equal(monthPeriodBounds('2024-02-29').period, '2024-02-01');
});
test('GET y consulta mensual tienen el contrato del panel sin persistir resultados', async () => {
  const fx = routeFixture();
  const list = await fx.invoke('get', path, { query: { sede_id: '7' } });
  assert.equal(list.statusCode, 200); assert.equal(list.body.policy.rulesVersion, INCENTIVE_RULES_VERSION);
  assert.equal(list.body.policy.billingEnabled, false);
  const program = list.body.programs[0];
  assert.equal(program.legacy_configuration, false);
  assert.equal(program.current_progress.period, monthPeriodBounds(new Date()).period);
  const month = await fx.invoke('post', `${path}/:sedeId/evaluar`, { body: { periodo: '2026-09-01' } });
  assert.equal(month.statusCode, 200); assert.equal(month.body.period, '2026-09-01');
  assert.equal(month.body.evaluation.criterios_requeridos, 4); assert.equal(month.body.evaluation.cumplido, true);
  assert.equal(month.body.evidence[0].final_marcador_verificado, true);
  assert.equal(month.body.evidence[0].parejas_confirmadas, 8);
  assert.equal(month.body.preview, true); assert.equal(month.body.persisted, false); assert.equal(month.body.credito_otorgado, false);
  assert.equal(month.body.commercial_status.billing_enabled, false);
  assert.deepEqual(fx.writes, []); assert.deepEqual(fx.metrics.writes, []);
});
test('mes previo devuelve su actividad sin copiar el cumplimiento del mes actual', async () => {
  const fx = routeFixture();
  const res = await fx.invoke('post', `${path}/:sedeId/evaluar`, { body: { periodo: '2026-08-01' } });
  assert.equal(res.statusCode, 200); assert.equal(res.body.period, '2026-08-01');
  assert.deepEqual(res.body.metrics, { torneos_integrales_validos: 0, torneos_resultados_completos: 0, reservas_validas: 0, jugadores_activos: 0 });
  assert.equal(res.body.evaluation.cumplido, false); assert.deepEqual(fx.writes, []);
});
test('consulta mensual rechaza fecha parcial, imposible o futura antes de leer datos', async () => {
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1);
  for (const periodo of ['2026-09-18', '2026-02-31', '2026-09-01junk', '', next.toISOString().slice(0, 10)]) {
    const fx = routeFixture();
    const res = await fx.invoke('post', `${path}/:sedeId/evaluar`, { body: { periodo } });
    assert.equal(res.statusCode, 400); assert.deepEqual(fx.reads, []); assert.deepEqual(fx.metrics.requests, []);
  }
});
test('autorización por sede y superadmin precede lecturas o escrituras', async () => {
  for (const method of ['get', 'post']) {
    const fx = routeFixture({ denied: true });
    const res = await fx.invoke(method, method === 'get' ? path : `${path}/:sedeId/evaluar`, { query: { sede_id: '7' } });
    assert.equal(res.statusCode, 403); assert.deepEqual(fx.reads, []); assert.deepEqual(fx.writes, []);
  }
  for (const [method, suffix] of [['post', '/activar'], ['patch', '']]) {
    const fx = routeFixture({ superAdmin: false });
    const res = await fx.invoke(method, `${path}/:sedeId${suffix}`, { body });
    assert.equal(res.statusCode, 403); assert.deepEqual(fx.reads, []); assert.deepEqual(fx.writes, []);
  }
});
test('legado conserva configuración e historial y no se evalúa con V4 en la API', async () => {
  const fx = routeFixture({ programs: [legacy] }); const before = structuredClone(fx.storage);
  const list = await fx.invoke('get', path, { query: { sede_id: '7' } });
  assert.equal(list.body.programs[0].legacy_configuration, true);
  assert.equal(list.body.programs[0].current_progress, null);
  assert.equal(list.body.programs[0].progress_reason_code, 'rules_migration_required');
  const evaluated = await fx.invoke('post', `${path}/:sedeId/evaluar`, { body: { periodo: '2026-09-01' } });
  assert.equal(evaluated.statusCode, 409); assert.equal(evaluated.body.code, 'RULES_MIGRATION_REQUIRED');
  assert.deepEqual(fx.storage, before); assert.deepEqual(fx.metrics.requests, []); assert.deepEqual(fx.writes, []);
});
test('POST de borrador no reemplaza programas existentes de ninguna versión/estado', async () => {
  for (const program of [legacy, { ...legacy, estado: 'activo' }, { ...legacy, ...body }, { ...legacy, ...body, estado: 'activo' }]) {
    const fx = routeFixture({ programs: [program] }); const before = structuredClone(fx.storage);
    const res = await fx.invoke('post', `${path}/:sedeId/activar`, { body });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'PROGRAM_ALREADY_EXISTS');
    assert.deepEqual(fx.storage, before); assert.deepEqual(fx.writes, []);
  }
});
test('borrador nuevo se inserta una vez; conflicto concurrente tampoco sobrescribe', async () => {
  const fx = routeFixture({ programs: [] });
  const first = await fx.invoke('post', `${path}/:sedeId/activar`, { body });
  assert.equal(first.statusCode, 201); assert.equal(first.body.estado, 'borrador'); assert.equal(first.body.reglas_version, INCENTIVE_RULES_VERSION);
  const second = await fx.invoke('post', `${path}/:sedeId/activar`, { body });
  assert.equal(second.statusCode, 409); assert.equal(fx.storage.sede_programas_beneficios.length, 1); assert.equal(fx.writes.length, 1);
  const race = routeFixture({ programs: [], insertConflict: true });
  const conflict = await race.invoke('post', `${path}/:sedeId/activar`, { body });
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.body.code, 'PROGRAM_ALREADY_EXISTS'); assert.deepEqual(race.writes, []);
});
test('PATCH conserva todos los legados y estados activos; sólo cambia borradores ya V4', async () => {
  for (const program of [legacy, { ...legacy, estado: 'activo' }, { ...legacy, ...body, estado: 'activo' }]) {
    const fx = routeFixture({ programs: [program] }); const before = structuredClone(fx.storage);
    const res = await fx.invoke('patch', `${path}/:sedeId`, { body });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'PROGRAM_REQUIRES_V4_DRAFT');
    assert.deepEqual(fx.storage, before); assert.deepEqual(fx.writes, []);
  }
  const fx = routeFixture(); const result = await fx.invoke('patch', `${path}/:sedeId`, { body });
  assert.equal(result.statusCode, 200); assert.equal(result.body.estado, 'borrador'); assert.equal(fx.writes.length, 1);
});
test('no permite activar, pausar o finalizar desde el configurador informativo', async () => {
  for (const estado of ['activo', 'pausado', 'finalizado']) for (const method of ['post', 'patch']) {
    const fx = routeFixture({ programs: [] });
    const res = await fx.invoke(method, `${path}/:sedeId${method === 'post' ? '/activar' : ''}`, { body: { ...body, estado } });
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'COMMERCIAL_ACTIVATION_CLOSED'); assert.deepEqual(fx.writes, []);
  }
});
test('suscripción activa impide crear programa y fallos de datos no fabrican cumplimiento', async () => {
  const billed = routeFixture({ programs: [], stripeSubscription: 'fixture-subscription' });
  assert.equal((await billed.invoke('post', `${path}/:sedeId/activar`, { body })).statusCode, 409); assert.deepEqual(billed.writes, []);
  const failed = routeFixture({ metricsFailure: 'reservas' });
  const result = await failed.invoke('get', path, { query: { sede_id: '7' } });
  assert.equal(result.statusCode, 200); assert.equal(result.body.programs[0].current_progress, null);
  assert.equal(result.body.programs[0].progress_reason_code, 'metrics_unavailable'); assert.deepEqual(failed.writes, []);
});
