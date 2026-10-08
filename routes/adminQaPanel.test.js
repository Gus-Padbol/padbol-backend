import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobalAdminAnalytics } from './adminQaPanel.js';

function query(rows) {
  const promise = Promise.resolve({ data: rows, error: null });
  return {
    select() { return this; },
    order() { return this; },
    in() { return this; },
    eq() { return this; },
    then(resolve, reject) { return promise.then(resolve, reject); },
  };
}

test('analytics globales separa estados, mes, deportes y países', async () => {
  const tables = {
    jugadores_perfil: [
      { id: 1, created_at: '2026-10-02T10:00:00Z' },
      { id: 2, created_at: '2026-09-02T10:00:00Z' },
    ],
    sedes: [
      { id: 1, pais: 'Argentina', estado: 'activa' },
      { id: 2, pais: '🇦🇷 Argentina', estado: 'suspendida' },
      { id: 3, pais: 'España', estado: 'activa' },
    ],
    torneos: [
      { id: 1, deporte: 'padbol', estado: 'finalizado', fecha_fin: '2026-09-01' },
      { id: 2, deporte: 'padbol', estado: 'en_curso', fecha_fin: '2026-12-01' },
      { id: 3, deporte: 'tenis', estado: 'en_curso', fecha_fin: '2026-09-01' },
    ],
    reservas: [
      { id: 1, estado: 'confirmada', fecha: '2026-10-03', cancelada: false, deporte: 'tenis' },
      { id: 2, estado: 'cancelada', fecha: '2026-10-03', cancelada: true },
      { id: 3, estado: 'pendiente', fecha: '2026-10-03', cancelada: false },
      { id: 4, estado: 'completada', fecha: '2026-09-30', cancelada: false, cancha_id: 99 },
    ],
    canchas: [{ id: 99, deporte: 'tenis' }],
  };
  const supabase = { from(name) { return query(tables[name] || []); } };
  const result = await buildGlobalAdminAnalytics(supabase, new Date('2026-10-07T12:00:00Z'));

  assert.equal(result.jugadores_registrados_total, 2);
  assert.equal(result.jugadores_nuevos_este_mes, 1);
  assert.equal(result.sedes_activas_total, 2);
  assert.equal(result.torneos_finalizados_total, 2);
  assert.equal(result.reservas_ultimo_mes_total, 1);
  assert.deepEqual(result.deporte_mas_popular, {
    deporte: 'tenis', label: 'Tenis', reservas_realizadas: 2, torneos_creados: 2,
  });
  assert.deepEqual(result.sedes_por_pais_top5, [
    { pais: 'Argentina', cantidad: 2, sedes_total: 2 },
    { pais: 'España', cantidad: 1, sedes_total: 1 },
  ]);
});

test('analytics usa las tablas y columnas existentes en producción', async () => {
  const columns = {
    jugadores_perfil: new Set(['id', 'created_at']),
    sedes: new Set(['id', 'pais', 'estado']),
    torneos: new Set(['id', 'deporte', 'estado', 'fecha_fin']),
    reservas: new Set(['id', 'estado', 'fecha', 'created_at', 'deporte', 'cancha_id']),
    canchas: new Set(['id', 'deporte']),
  };
  const supabase = { from(name) {
    assert.ok(columns[name], `La tabla ${name} no existe`);
    const builder = query([]);
    builder.select = function (selected) {
      for (const column of selected.split(',')) {
        assert.ok(columns[name].has(column), `La columna ${name}.${column} no existe`);
      }
      return this;
    };
    return builder;
  } };
  const result = await buildGlobalAdminAnalytics(supabase);
  assert.equal(result.jugadores_registrados_total, 0);
  assert.equal(result.reservas_ultimo_mes_total, 0);
});
