import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  CODIGO_HORARIOS_UNAVAILABLE,
  CODIGO_SEDE_TIMEZONE_INVALIDA,
  cargarHorariosPorClase,
  detectarEsquemaHorarios,
  fechaHoraEnZona,
} from './horarios.js';

/**
 * Validación contra PostgreSQL LOCAL efímero con el DDL efectivo de
 * `clases_horarios(dia_semana, hora_inicio, hora_fin)`.
 * Sólo corre con CLASES_HORARIOS_PG_URL apuntando a la base dedicada
 * `clases_horarios_test` en 127.0.0.1:55445. Nunca abre otra URL.
 */
const CS = process.env.CLASES_HORARIOS_PG_URL;
const it = CS ? test : test.skip;

export function assertSafeClasesPgUrl(url) {
  const raw = String(url || '');
  const refuse = () => {
    throw new Error('REFUSE_NON_LOCAL_CLASES_PG');
  };
  if (!/^postgres(?:ql)?:\/\//.test(raw) || raw.includes('#')) refuse();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    refuse();
  }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) refuse();
  if (Number(parsed.port) !== 55445) refuse();
  if (parsed.pathname !== '/clases_horarios_test') refuse();
  if ([...parsed.searchParams.keys()].some((key) => key !== 'sslmode')) refuse();
  let effective;
  try {
    effective = new pg.Client({ connectionString: raw }).connectionParameters;
  } catch {
    refuse();
  }
  if (!['127.0.0.1', 'localhost'].includes(effective.host)) refuse();
  if (Number(effective.port) !== 55445 || effective.database !== 'clases_horarios_test') refuse();
  return true;
}

test('la guarda de PG rechaza cualquier destino no local o no dedicado', () => {
  assert.throws(
    () => assertSafeClasesPgUrl('postgresql://postgres@db.example.com:55445/clases_horarios_test'),
    /REFUSE/,
  );
  assert.throws(
    () => assertSafeClasesPgUrl('postgresql://postgres@127.0.0.1:5432/clases_horarios_test'),
    /REFUSE/,
  );
  assert.throws(
    () => assertSafeClasesPgUrl('postgresql://postgres@127.0.0.1:55445/postgres'),
    /REFUSE/,
  );
  assert.equal(
    assertSafeClasesPgUrl('postgresql://postgres@127.0.0.1:55445/clases_horarios_test'),
    true,
  );
});

/**
 * Adaptador mínimo PostgREST-like sobre pg para ejercitar el MISMO camino de
 * consulta del router (select/in/gte/order/limit) contra SQL real. Los errores
 * de columna inexistente (42703) se devuelven como `{ data:null, error }`,
 * igual que supabase-js, para que la detección de esquema sea la real.
 */
function createPgSupabase(pool) {
  const identificador = /^[a-z_][a-z0-9_]*$/;
  return {
    from(tabla) {
      if (!identificador.test(tabla)) throw new Error('tabla inválida');
      const st = { tabla, columnas: '*', filtros: [], orden: [], limite: null, single: false };

      async function ejecutar() {
        const params = [];
        const donde = [];
        for (const [op, col, value] of st.filtros) {
          if (!identificador.test(col)) throw new Error('columna inválida');
          if (op === 'eq') {
            params.push(value);
            donde.push(`${col} = $${params.length}`);
          } else if (op === 'in') {
            const marcas = (value || []).map((v) => {
              params.push(v);
              return `$${params.length}`;
            });
            if (marcas.length === 0) return { data: [], error: null };
            donde.push(`${col} IN (${marcas.join(', ')})`);
          } else if (op === 'gte') {
            params.push(value);
            donde.push(`${col} >= $${params.length}`);
          }
        }
        const columnas = st.columnas === '*'
          ? '*'
          : String(st.columnas).split(',').map((c) => c.trim());
        for (const col of columnas === '*' ? [] : columnas) {
          if (!identificador.test(col)) throw new Error('columna inválida');
        }
        const sql = [
          `SELECT ${columnas === '*' ? '*' : columnas.join(', ')} FROM public.${tabla}`,
          donde.length ? `WHERE ${donde.join(' AND ')}` : '',
          st.orden.length ? `ORDER BY ${st.orden.join(', ')}` : '',
          st.limite != null ? `LIMIT ${st.limite}` : '',
        ].filter(Boolean).join(' ');
        try {
          const { rows } = await pool.query(sql, params);
          return { data: st.single ? rows[0] ?? null : rows, error: null };
        } catch (error) {
          return { data: null, error: { message: error.message, code: error.code } };
        }
      }

      const api = {
        select(columnas) { st.columnas = columnas || '*'; return api; },
        eq(col, value) { st.filtros.push(['eq', col, value]); return api; },
        in(col, values) { st.filtros.push(['in', col, values]); return api; },
        gte(col, value) { st.filtros.push(['gte', col, value]); return api; },
        order(col, opciones) {
          st.orden.push(`${col} ${opciones?.ascending === false ? 'DESC' : 'ASC'}`);
          return api;
        },
        limit(n) { st.limite = n; return api; },
        maybeSingle() { st.single = true; return api; },
        single() { st.single = true; return api; },
        then(resolve, reject) { return ejecutar().then(resolve, reject); },
      };
      return api;
    },
  };
}

const BA = 'America/Argentina/Buenos_Aires';
const KIRITIMATI = 'Pacific/Kiritimati';
const NY = 'America/New_York';

function poolFixture() {
  assertSafeClasesPgUrl(CS);
  return new pg.Pool({ connectionString: CS, max: 4 });
}

async function limpiar(pool) {
  await pool.query('DROP TABLE IF EXISTS public.clases_horarios; DROP TABLE IF EXISTS public.clases_disponibilidad;');
}

it('el DDL efectivo no tiene fecha/hora: la consulta vieja del router falla 42703', async () => {
  const pool = poolFixture();
  try {
    await limpiar(pool);
    // DDL real (sql/tests/20261016_tournament_planning_bootstrap.sql).
    await pool.query('CREATE TABLE public.clases_horarios (clase_id bigint, dia_semana integer, hora_inicio time, hora_fin time)');
    await pool.query(
      "INSERT INTO public.clases_horarios VALUES (7,0,'09:00','10:00'), (9,0,'09:00','10:00'), (10,0,'10:00','11:00')",
    );
    await assert.rejects(
      () => pool.query('SELECT fecha, hora FROM public.clases_horarios'),
      (error) => error.code === '42703',
      'contra el DDL recurrente la consulta fecha/hora debe fallar',
    );
  } finally {
    await pool.end();
  }
});

it('PostgreSQL real: dos sedes con cambio de día y DST resuelven por sedes.timezone', async () => {
  const pool = poolFixture();
  try {
    await limpiar(pool);
    await pool.query('CREATE TABLE public.clases_horarios (clase_id bigint, dia_semana integer, hora_inicio time, hora_fin time)');
    await pool.query(
      "INSERT INTO public.clases_horarios VALUES (7,0,'09:00','10:00'), (9,0,'09:00','10:00'), (10,0,'10:00','11:00')",
    );

    const supabase = createPgSupabase(pool);
    assert.deepEqual(await detectarEsquemaHorarios(supabase), {
      tabla: 'clases_horarios',
      forma: 'recurrente',
    });

    const ahora = new Date('2026-11-22T02:30:00.000Z');
    assert.deepEqual(fechaHoraEnZona(ahora, BA), { fecha: '2026-11-21', hora: '23:30', zona: BA });
    assert.deepEqual(fechaHoraEnZona(ahora, KIRITIMATI), { fecha: '2026-11-22', hora: '16:30', zona: KIRITIMATI });

    const salida = await cargarHorariosPorClase(
      supabase,
      { tabla: 'clases_horarios', forma: 'recurrente' },
      [7, 9, 10],
      { ahora, zonaPorClaseId: { 7: BA, 9: KIRITIMATI, 10: NY } },
    );
    assert.equal(salida['7'][0].fecha, '2026-11-22', 'BA: sábado 23:30 -> domingo 09:00');
    assert.equal(salida['7'][0].hora, '09:00');
    assert.equal(salida['7'][0].zona_horaria, BA);
    assert.equal(salida['9'][0].fecha, '2026-11-29', 'Kiritimati: domingo 16:30, 09:00 ya pasó');
    assert.equal(salida['9'][0].zona_horaria, KIRITIMATI);
    assert.equal(salida['10'][0].fecha, '2026-11-22');
    assert.equal(salida['10'][0].hora, '10:00');

    // DST: 2026-11-01 termina el horario de verano en NY; la hora de pared se conserva.
    const salidaDst = await cargarHorariosPorClase(
      supabase,
      { tabla: 'clases_horarios', forma: 'recurrente' },
      [10],
      { ahora: new Date('2026-10-31T12:00:00.000Z'), zonaPorClaseId: { 10: NY } },
    );
    assert.equal(salidaDst['10'][0].fecha, '2026-11-01');
    assert.equal(salidaDst['10'][0].hora, '10:00');
    assert.equal(salidaDst['10'][0].zona_horaria, NY);
  } finally {
    await pool.end();
  }
});

it('PostgreSQL real: legacy sólo con fecha/hora reales, filtrado por calendario local', async () => {
  const pool = poolFixture();
  try {
    await limpiar(pool);
    await pool.query('CREATE TABLE public.clases_disponibilidad (clase_id bigint, fecha date, hora time)');
    await pool.query(
      "INSERT INTO public.clases_disponibilidad VALUES (7,'2030-01-10','18:30'), (7,'2030-01-11',NULL), (7,'2020-01-01','10:00')",
    );

    const supabase = createPgSupabase(pool);
    assert.deepEqual(await detectarEsquemaHorarios(supabase), {
      tabla: 'clases_disponibilidad',
      forma: 'legacy',
    });

    const salida = await cargarHorariosPorClase(
      supabase,
      { tabla: 'clases_disponibilidad', forma: 'legacy' },
      [7],
      { ahora: new Date('2026-11-22T02:30:00.000Z'), zonaPorClaseId: { 7: BA } },
    );
    assert.equal(salida['7'].length, 1, 'descarta fecha pasada y fila sin hora');
    assert.equal(salida['7'][0].fecha, '2030-01-10');
    assert.equal(salida['7'][0].hora, '18:30');
    assert.equal(salida['7'][0].recurrente, false);
    assert.equal(salida['7'][0].zona_horaria, BA);
  } finally {
    await pool.end();
  }
});

it('PostgreSQL real: ausencia de tablas de horarios no es fallo técnico', async () => {
  const pool = poolFixture();
  try {
    await limpiar(pool);
    const supabase = createPgSupabase(pool);
    assert.equal(await detectarEsquemaHorarios(supabase), null);
  } finally {
    await pool.end();
  }
});

it('PostgreSQL real: fallo de lectura de horarios es error técnico y se recupera', async () => {
  const pool = poolFixture();
  try {
    await limpiar(pool);
    await pool.query('CREATE TABLE public.clases_horarios (clase_id bigint, dia_semana integer, hora_inicio time, hora_fin time)');
    await pool.query("INSERT INTO public.clases_horarios VALUES (7,0,'09:00','10:00')");
    const supabase = createPgSupabase(pool);
    const esquema = await detectarEsquemaHorarios(supabase);
    assert.deepEqual(esquema, { tabla: 'clases_horarios', forma: 'recurrente' });

    // La tabla desaparece entre detección y lectura: error técnico, no vacío.
    await pool.query('DROP TABLE public.clases_horarios');
    await assert.rejects(
      () => cargarHorariosPorClase(supabase, esquema, [7], {
        ahora: new Date('2026-11-22T02:30:00.000Z'),
        zonaPorClaseId: { 7: BA },
      }),
      (error) => error.code === CODIGO_HORARIOS_UNAVAILABLE,
    );

    // Recuperación: la tabla vuelve y el loader (sin cache propio) responde.
    await pool.query('CREATE TABLE public.clases_horarios (clase_id bigint, dia_semana integer, hora_inicio time, hora_fin time)');
    await pool.query("INSERT INTO public.clases_horarios VALUES (7,0,'09:00','10:00')");
    const recuperado = await cargarHorariosPorClase(supabase, esquema, [7], {
      ahora: new Date('2026-11-22T02:30:00.000Z'),
      zonaPorClaseId: { 7: BA },
    });
    assert.equal(recuperado['7'][0].fecha, '2026-11-22');
  } finally {
    await pool.end();
  }
});

it('PostgreSQL real: sede sin timezone o inválida no asume Argentina', async () => {
  const pool = poolFixture();
  try {
    await limpiar(pool);
    await pool.query('CREATE TABLE public.clases_horarios (clase_id bigint, dia_semana integer, hora_inicio time, hora_fin time)');
    await pool.query("INSERT INTO public.clases_horarios VALUES (7,0,'09:00','10:00')");
    const supabase = createPgSupabase(pool);
    const esquema = await detectarEsquemaHorarios(supabase);
    for (const zona of [null, '', 'Marte/Olympus']) {
      await assert.rejects(
        () => cargarHorariosPorClase(supabase, esquema, [7], {
          ahora: new Date('2026-11-22T02:30:00.000Z'),
          zonaPorClaseId: { 7: zona },
        }),
        (error) => error.code === CODIGO_SEDE_TIMEZONE_INVALIDA,
        `zona ${JSON.stringify(zona)}`,
      );
    }
  } finally {
    await pool.end();
  }
});

it('PostgreSQL real: fallo de conexión en la detección es 503, no ausencia', async () => {
  const pool = new pg.Pool({ connectionString: CS, max: 1 });
  const supabase = createPgSupabase(pool);
  await pool.end();
  await assert.rejects(
    () => detectarEsquemaHorarios(supabase),
    (error) => error.code === CODIGO_HORARIOS_UNAVAILABLE,
  );
});
