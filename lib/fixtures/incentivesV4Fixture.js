import { buildHistorialPuntoSnapshot } from '../../utils/scoreboardLogic.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FOUR_GOAL_RULES, INCENTIVE_RULES_VERSION, evaluateSedeIncentive } from '../sedeIncentivesV4.js';
const schema = JSON.parse(await readFile(new URL('./incentives-v4-schema-columns.json', import.meta.url), 'utf8'));
const userId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const timestamp = '2026-09-04T15:00:00.000Z';
const period = '2026-09-01';
const configured = { id: 1, sede_id: 7, fecha_inicio: '2026-01-01', reglas_version: INCENTIVE_RULES_VERSION, configuracion: FOUR_GOAL_RULES };
const LEGACY_RULES = { torneos_minimos: 1, jugadores_registrados_minimos: 8, partidos_marcador_minimos: 3, reservas_minimas: 10, jugadores_activos_minimos: 10, movimientos_padcoins_minimos: 5 };
const completeMetrics = { torneos_integrales_validos: 1, torneos_resultados_completos: 1, reservas_validas: 12, jugadores_activos: 16 };

function fixture({ playedMatches = 15, digitalMatches = playedMatches } = {}) {
  const tables = Object.fromEntries(Object.keys(schema).map((name) => [name, []]));
  tables.canchas = [{ id: 1, sede_id: 7, estado: 'activa', deporte: 'padbol' }];
  tables.torneos = [{ id: 101, sede_id: 7, estado: 'finalizado', fecha_fin: '2026-09-04', deporte: 'padbol', formato_equipo: 'dobles', tipo_torneo: playedMatches === 7 ? 'knockout' : 'grupos_knockout' }];
  tables.jugadores_perfil = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, user_id: userId(i + 1) }));
  tables.sede_jugadores = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, user_id: userId(i + 1), sede_id: 7, estado: 'activo' }));
  tables.equipos = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, torneo_id: 101, inscripcion_estado: 'confirmado', jugadores: [{ user_id: userId(i * 2 + 1) }, { user_id: userId(i * 2 + 2) }] }));
  // Two round-robin groups of four, two semifinals and the final: 12 + 2 + 1.
  const groupPairs = [
    [1, 2], [3, 4], [5, 6], [7, 8],
    [1, 3], [1, 4], [2, 3], [2, 4], [5, 7], [5, 8], [6, 7], [6, 8],
    [1, 6], [5, 2], [1, 5],
  ];
  const knockoutPairs = [[1, 2], [3, 4], [5, 6], [7, 8], [1, 3], [5, 7], [1, 5]];
  const pairs = playedMatches === 7 ? knockoutPairs : groupPairs.slice(0, playedMatches);
  for (let i = 0; i < pairs.length; i += 1) {
    const pid = 1001 + i, sid = userId(1001 + i);
    tables.partidos.push({ id: pid, torneo_id: 101, sede_id: 7, estado: 'finalizado', resultado: { goles_a: 2, goles_b: 0 }, equipo_a_id: pairs[i][0], equipo_b_id: pairs[i][1], ganador_equipo_id: pairs[i][0] });
    if (!(digitalMatches > 0 && (i < digitalMatches - 1 || i === pairs.length - 1))) {
      tables.partidos.at(-1).resultado = JSON.stringify({ set1: '6-3', set2: '6-4', set3: '', ganador_id: pairs[i][0] });
      tables.partidos.at(-1).ganador_equipo_id = null;
      continue;
    }
    tables.scoreboard_partidos.push({ id: sid, sede_id: 7, torneo_id: 101, partido_torneo_id: pid, estado: 'terminado', sets_a: 2, sets_b: 0, historial_sets: [{ set: 1, a: 6, b: 3 }, { set: 2, a: 6, b: 4 }], sync_torneo_status: 'synced', synced_to_torneo_at: timestamp, updated_at: timestamp });
    tables.scoreboard_historial_puntos.push({ id: userId(2001 + i), partido_id: sid, timestamp: '2026-09-04T14:59:00.000Z',
      ...buildHistorialPuntoSnapshot({ estado:'en_curso', sets_a:1, sets_b:0, games_a:5, games_b:4, score_a:40, score_b:0,
        es_tiebreak:false, saque_actual:'A', historial_sets:[{set:1,a:6,b:3}] }, 'A') });
  }
  // Existing generated bracket structure, including actual advancement links.
  tables.partidos.forEach((row, index) => {
    if (playedMatches !== 7 && index < 12) {
      row.grupo = row.equipo_a_id <= 4 ? 'A' : 'B';
      return;
    }
    const start = playedMatches === 7 ? 0 : 12;
    const offset = index - start;
    if (playedMatches === 7) {
      row.bracket_round = offset < 4 ? 1 : offset < 6 ? 2 : 3;
      row.bracket_position = offset < 4 ? offset + 1 : offset < 6 ? offset - 3 : 1;
      if (offset < 6) {
        row.partido_siguiente_id = offset < 4 ? 1005 + Math.floor(offset / 2) : 1007;
        row.partido_siguiente_slot = offset % 2 === 0 ? 'A' : 'B';
      }
    } else {
      row.bracket_round = offset < 2 ? 1 : 2;
      row.bracket_position = offset < 2 ? offset + 1 : 1;
      if (offset < 2) { row.partido_siguiente_id = 1015; row.partido_siguiente_slot = offset === 0 ? 'A' : 'B'; }
    }
  });
  tables.reservas = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, sede_id: 7, user_id: userId(i + 1), estado: 'completada', fecha: '2026-09-04', deporte: 'padbol', origen_creacion: 'checkout_jugador_v1', checkin_realizado: true, checkin_at: timestamp, created_at: '2026-08-20T12:00:00' }));
  return tables;
}

// The adapter executes projection, filtering, ordering and pagination, and rejects
// every column absent from the baseline schema plus the explicit candidate
// origen_creacion migration. This does not assert that migration is deployed.
function client(tables, { unverified = new Set(), failTable, missingAuth = false, missingUsers = new Set() } = {}) {
  const requests = [], writes = [];
  for (const [table, rows] of Object.entries(tables)) {
    assert(schema[table], `Unexpected table ${table}`);
    for (const row of rows) for (const key of Object.keys(row)) assert(schema[table].includes(key), `Unknown fixture column ${table}.${key}`);
  }
  const query = (table) => {
    assert(schema[table], `Unknown queried table ${table}`);
    const filters = []; let columns, order, range;
    const api = {
      select(raw) { columns = raw.split(',').map((x) => x.trim()); columns.forEach((column) => assert(schema[table].includes(column), `Unknown selected column ${table}.${column}`)); return api; },
      eq(key, value) { assert(schema[table].includes(key)); filters.push((row) => row[key] === value); return api; },
      in(key, values) { assert(schema[table].includes(key)); filters.push((row) => values.includes(row[key])); return api; },
      gte(key, value) { assert(schema[table].includes(key)); filters.push((row) => row[key] >= value); return api; },
      lt(key, value) { assert(schema[table].includes(key)); filters.push((row) => row[key] < value); return api; },
      order(key, options) { assert(schema[table].includes(key)); order = [key, options]; return api; },
      range(from, to) { range = [from, to]; return api; },
      then(resolve, reject) {
        requests.push({ table, columns, range });
        if (table === failTable) return Promise.resolve({ data: null, error: new Error('fixture query unavailable') }).then(resolve, reject);
        let rows = tables[table].filter((row) => filters.every((filter) => filter(row)));
        if (order) rows.sort((a, b) => (a[order[0]] > b[order[0]] ? 1 : a[order[0]] < b[order[0]] ? -1 : 0) * (order[1].ascending ? 1 : -1));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        rows = rows.map((row) => Object.fromEntries(columns.map((key) => [key, row[key]])));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
      insert() { writes.push('insert'); throw new Error('No writes allowed'); },
      update() { writes.push('update'); throw new Error('No writes allowed'); },
      upsert() { writes.push('upsert'); throw new Error('No writes allowed'); },
    };
    return api;
  };
  return { from: query, requests, writes, auth: missingAuth ? undefined : { admin: { async getUserById(id) {
    if (missingUsers.has(id)) return { data: { user: null }, error: { status: 404 } };
    return { data: { user: { id, email_confirmed_at: unverified.has(id) ? null : '2026-08-01T00:00:00Z', is_anonymous: false } }, error: null };
  } } } };
}
async function run(tables = fixture(), options = {}, program = configured, requestedPeriod = period) {
  const supabase = client(tables, options);
  const result = await evaluateSedeIncentive(supabase, program, requestedPeriod);
  assert.equal(supabase.writes.length, 0);
  assert(!supabase.requests.some((row) => row.table.includes('padcoins')));
  return { result, supabase };
}


export { schema, userId, timestamp, period, configured, LEGACY_RULES, completeMetrics, fixture, client, run };
