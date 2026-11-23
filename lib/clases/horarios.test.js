import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODIGO_HORARIOS_UNAVAILABLE,
  CODIGO_SEDE_TIMEZONE_INVALIDA,
  ZONA_FALLBACK,
  cargarHorariosPorClase,
  detectarEsquemaHorarios,
  diaSemanaDesdeYmd,
  fechaHoraEnZona,
  horaEnZona,
  hoyEnZona,
  motivoZonaInvalida,
  normalizarHorario,
  normalizarZona,
  normalizeHora,
  proximaFechaRecurrente,
  sumarDiasYmd,
  zonaValida,
} from './horarios.js';

const BA = 'America/Argentina/Buenos_Aires';
const KIRITIMATI = 'Pacific/Kiritimati';
const NY = 'America/New_York';

test('normalizeHora acepta HH:MM con segundos y rechaza valores inválidos', () => {
  assert.equal(normalizeHora('18:30:00'), '18:30');
  assert.equal(normalizeHora('9:05'), '09:05');
  assert.equal(normalizeHora('23:59:59.999'), '23:59');
  assert.equal(normalizeHora('24:00'), null);
  assert.equal(normalizeHora('18:60'), null);
  assert.equal(normalizeHora(''), null);
  assert.equal(normalizeHora(null), null);
});

test('diaSemanaDesdeYmd usa el calendario, no la TZ del proceso', () => {
  assert.equal(diaSemanaDesdeYmd('2026-11-22'), 0); // domingo
  assert.equal(diaSemanaDesdeYmd('2026-11-26'), 4); // jueves
  assert.equal(diaSemanaDesdeYmd('2026-11-28'), 6); // sábado
  assert.equal(diaSemanaDesdeYmd('no-es-fecha'), null);
  assert.equal(sumarDiasYmd('2026-11-28', 3), '2026-12-01');
});

test('proximaFechaRecurrente resuelve hoy, futuro y hora ya pasada', () => {
  const base = { hoyYmd: '2026-11-22', horaActual: '10:00' };
  assert.equal(
    proximaFechaRecurrente({ ...base, diaSemana: 0, horaInicio: '18:30' }),
    '2026-11-22',
    'turno de hoy con hora futura se mantiene hoy',
  );
  assert.equal(
    proximaFechaRecurrente({ ...base, diaSemana: 0, horaInicio: '09:00' }),
    '2026-11-29',
    'turno de hoy ya iniciado pasa a la semana siguiente',
  );
  assert.equal(
    proximaFechaRecurrente({ ...base, diaSemana: 4, horaInicio: '18:30' }),
    '2026-11-26',
  );
  // Cambio de horario de verano en NY (2026-11-01): el calendario local manda.
  assert.equal(
    proximaFechaRecurrente({ hoyYmd: '2026-10-31', horaActual: '08:00', diaSemana: 0, horaInicio: '10:00' }),
    '2026-11-01',
  );
  assert.equal(proximaFechaRecurrente({ ...base, diaSemana: 7, horaInicio: '10:00' }), null);
  assert.equal(proximaFechaRecurrente({ hoyYmd: null, diaSemana: 1, horaInicio: '10:00' }), null);
});

test('normalizarZona valida IANA y cae al fallback Argentina', () => {
  assert.equal(normalizarZona('America/New_York'), NY);
  assert.equal(normalizarZona('  Pacific/Kiritimati '), KIRITIMATI);
  assert.equal(normalizarZona(''), ZONA_FALLBACK);
  assert.equal(normalizarZona(null), ZONA_FALLBACK);
  assert.equal(normalizarZona('Marte/Olympus'), ZONA_FALLBACK);
  assert.equal(normalizarZona('Zona con espacios'), ZONA_FALLBACK);
});

test('dos sedes con el mismo instante y cambio de día', () => {
  const instante = new Date('2026-11-22T02:30:00.000Z');
  const enBA = fechaHoraEnZona(instante, BA);
  const enKir = fechaHoraEnZona(instante, KIRITIMATI);
  assert.deepEqual(enBA, { fecha: '2026-11-21', hora: '23:30', zona: BA });
  assert.deepEqual(enKir, { fecha: '2026-11-22', hora: '16:30', zona: KIRITIMATI });
  assert.equal(hoyEnZona(instante, BA), '2026-11-21');
  assert.equal(hoyEnZona(instante, KIRITIMATI), '2026-11-22');
  assert.equal(horaEnZona(instante, KIRITIMATI), '16:30');
});

test('DST: offsets de verano/invierno y hora repetida se resuelven por zona', () => {
  assert.equal(horaEnZona(new Date('2026-07-01T12:00:00.000Z'), NY), '08:00'); // EDT -4
  assert.equal(horaEnZona(new Date('2026-12-01T12:00:00.000Z'), NY), '07:00'); // EST -5
  // Spring forward 2026-03-08: 02:00 local no existe (01:59 -> 03:00).
  assert.equal(horaEnZona(new Date('2026-03-08T06:59:00.000Z'), NY), '01:59');
  assert.equal(horaEnZona(new Date('2026-03-08T07:00:00.000Z'), NY), '03:00');
  // Fall back 2026-11-01: 01:30 ocurre dos veces con offsets distintos.
  const primera = fechaHoraEnZona(new Date('2026-11-01T05:30:00.000Z'), NY);
  const segunda = fechaHoraEnZona(new Date('2026-11-01T06:30:00.000Z'), NY);
  assert.equal(primera.fecha, '2026-11-01');
  assert.equal(segunda.fecha, '2026-11-01');
  assert.equal(primera.hora, '01:30');
  assert.equal(segunda.hora, '01:30');
  // Kiritimati (UTC+14) no tiene DST.
  assert.equal(horaEnZona(new Date('2026-07-01T12:00:00.000Z'), KIRITIMATI), '02:00');
});

test('normalizarHorario recurrente calcula la ocurrencia en el calendario de la sede', () => {
  const horario = normalizarHorario(
    {
      id: 77,
      clase_id: 7,
      dia_semana: 4,
      hora_inicio: '18:30:00',
      hora_fin: '19:30:00',
      created_at: '2020-01-01T00:00:00.000Z',
    },
    { hoyYmd: '2026-11-22', horaActual: '10:00', zona: BA },
  );
  assert.deepEqual(horario, {
    horario_id: 77,
    fecha: '2026-11-26',
    hora: '18:30',
    dia_semana: 4,
    hora_inicio: '18:30',
    hora_fin: '19:30',
    recurrente: true,
    zona_horaria: BA,
  });
});

test('normalizarHorario legacy exige fecha/hora reales y no inventa desde created_at', () => {
  const directo = normalizarHorario(
    { id: 5, clase_id: 7, fecha: '2030-01-10', hora: '18:30:00' },
    { hoyYmd: '2026-11-22', zona: BA },
  );
  assert.equal(directo.fecha, '2030-01-10');
  assert.equal(directo.hora, '18:30');
  assert.equal(directo.recurrente, false);
  assert.equal(directo.zona_horaria, BA);

  assert.equal(
    normalizarHorario({ id: 6, clase_id: 7, created_at: '2030-02-03T14:05:00.000Z' }, { hoyYmd: '2026-11-22' }),
    null,
    'created_at no es un horario',
  );
  assert.equal(
    normalizarHorario({ id: 7, clase_id: 7, fecha: '2030-01-10', hora: null }, { hoyYmd: '2026-11-22' }),
    null,
    'fila legacy incompleta no produce ocurrencia',
  );
});

function fakeCliente({ columnasPorTabla, filas = [], falla = null, lanzar = null } = {}) {
  return {
    from(tabla) {
      const state = { columnas: null, filtros: [] };
      const error = (columna) => ({ message: `column ${columna} does not exist`, code: '42703' });
      const validar = (columnas, filtros) => {
        const declaradas = columnasPorTabla[tabla];
        if (!declaradas) {
          return {
            message: `Could not find the table 'public.${tabla}' in the schema cache`,
            code: 'PGRST205',
          };
        }
        for (const columna of columnas || []) {
          if (!declaradas.includes(columna)) return error(columna);
        }
        for (const [, columna] of filtros) {
          if (!declaradas.includes(columna)) return error(columna);
        }
        return null;
      };
      const ejecutar = async () => {
        if (lanzar) throw lanzar;
        if (falla) return { data: null, error: falla };
        const columnas = String(state.columnas || '*')
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c && c !== '*');
        const err = validar(columnas.length ? columnas : null, state.filtros);
        if (err) return { data: null, error: err };
        const filtradas = filas.filter((fila) =>
          state.filtros.every(([op, col, value]) => {
            if (op === 'eq') return String(fila[col]) === String(value);
            if (op === 'in') return (value || []).map(String).includes(String(fila[col]));
            if (op === 'gte') return String(fila[col] ?? '') >= String(value);
            return true;
          }),
        );
        return { data: filtradas, error: null };
      };
      const api = {
        select(columnas) { state.columnas = columnas; return api; },
        eq(col, value) { state.filtros.push(['eq', col, value]); return api; },
        in(col, values) { state.filtros.push(['in', col, values]); return api; },
        gte(col, value) { state.filtros.push(['gte', col, value]); return api; },
        order() { return api; },
        limit() { return api; },
        then(resolve, reject) { return ejecutar().then(resolve, reject); },
      };
      return api;
    },
  };
}

test('detectarEsquemaHorarios prefiere la forma recurrente real y cae a legacy', async () => {
  const recurrente = fakeCliente({
    columnasPorTabla: {
      clases_horarios: ['id', 'clase_id', 'dia_semana', 'hora_inicio', 'hora_fin'],
    },
  });
  assert.deepEqual(await detectarEsquemaHorarios(recurrente), {
    tabla: 'clases_horarios',
    forma: 'recurrente',
  });

  const legacy = fakeCliente({
    columnasPorTabla: {
      clases_horarios: ['id', 'clase_id', 'fecha', 'hora', 'created_at'],
    },
  });
  assert.deepEqual(await detectarEsquemaHorarios(legacy), {
    tabla: 'clases_horarios',
    forma: 'legacy',
  });

  const sinTablas = fakeCliente({ columnasPorTabla: {} });
  assert.equal(await detectarEsquemaHorarios(sinTablas), null);
});

test('detectarEsquemaHorarios distingue ausencia real de fallo técnico', async () => {
  const sinTablas = fakeCliente({ columnasPorTabla: {} });
  assert.equal(await detectarEsquemaHorarios(sinTablas), null, 'ausencia real no es error');

  const tecnico = fakeCliente({
    columnasPorTabla: { clases_horarios: ['id', 'clase_id', 'dia_semana'] },
    falla: { code: 'ETIMEDOUT', message: 'timeout' },
  });
  await assert.rejects(
    () => detectarEsquemaHorarios(tecnico),
    (error) => error.code === CODIGO_HORARIOS_UNAVAILABLE,
  );

  const lanzado = fakeCliente({
    columnasPorTabla: { clases_horarios: ['id', 'clase_id', 'dia_semana'] },
    lanzar: new Error('network down'),
  });
  await assert.rejects(
    () => detectarEsquemaHorarios(lanzado),
    (error) => error.code === CODIGO_HORARIOS_UNAVAILABLE,
  );

  const esquemaRaro = fakeCliente({ columnasPorTabla: { clases_horarios: ['id', 'clase_id'] } });
  await assert.rejects(
    () => detectarEsquemaHorarios(esquemaRaro),
    (error) => error.code === CODIGO_HORARIOS_UNAVAILABLE,
    'tabla existente sin forma conocida no es vacío válido',
  );
});

test('cargarHorariosPorClase resuelve dos sedes con fechas locales distintas y sin gte fecha', async () => {
  const consultas = [];
  const cliente = {
    from(tabla) {
      const state = { filtros: [] };
      consultas.push({ tabla, filtros: state.filtros });
      const api = {
        select() { return api; },
        in(col, values) { state.filtros.push(['in', col, values]); return api; },
        gte(col, value) { state.filtros.push(['gte', col, value]); return api; },
        order() { return api; },
        then(resolve) {
          return resolve({
            data: [
              { id: 1, clase_id: 7, dia_semana: 0, hora_inicio: '09:00:00', hora_fin: '10:00:00' },
              { id: 2, clase_id: 9, dia_semana: 0, hora_inicio: '09:00:00', hora_fin: '10:00:00' },
              { id: 3, clase_id: 10, dia_semana: 0, hora_inicio: '10:00:00', hora_fin: '11:00:00' },
            ],
            error: null,
          });
        },
      };
      return api;
    },
  };
  const salida = await cargarHorariosPorClase(
    cliente,
    { tabla: 'clases_horarios', forma: 'recurrente' },
    [7, 9, 10],
    {
      ahora: new Date('2026-11-22T02:30:00.000Z'),
      zonaPorClaseId: { 7: BA, 9: KIRITIMATI, 10: NY },
    },
  );
  // BA: sábado 23:30 -> domingo 2026-11-22 09:00.
  assert.equal(salida['7'][0].fecha, '2026-11-22');
  assert.equal(salida['7'][0].hora, '09:00');
  assert.equal(salida['7'][0].zona_horaria, BA);
  // Kiritimati: domingo 16:30, las 09:00 ya pasaron -> domingo 2026-11-29.
  assert.equal(salida['9'][0].fecha, '2026-11-29');
  assert.equal(salida['9'][0].zona_horaria, KIRITIMATI);
  // NY: sábado 21:30 -> domingo 2026-11-22 10:00.
  assert.equal(salida['10'][0].fecha, '2026-11-22');
  assert.equal(salida['10'][0].hora, '10:00');
  assert.ok(consultas.every((q) => !q.filtros.some(([op, col]) => op === 'gte' && col === 'fecha')));
});

test('cargarHorariosPorClase legacy filtra por fecha local y descarta filas incompletas', async () => {
  const consultas = [];
  const cliente = {
    from(tabla) {
      const state = { filtros: [] };
      consultas.push({ tabla, filtros: state.filtros });
      const api = {
        select() { return api; },
        in(col, values) { state.filtros.push(['in', col, values]); return api; },
        gte(col, value) { state.filtros.push(['gte', col, value]); return api; },
        order() { return api; },
        then(resolve) {
          return resolve({
            data: [
              { id: 3, clase_id: 7, fecha: '2030-01-10', hora: '18:30:00' },
              { id: 4, clase_id: 7, fecha: '2030-01-11', hora: null },
            ],
            error: null,
          });
        },
      };
      return api;
    },
  };
  const salida = await cargarHorariosPorClase(
    cliente,
    { tabla: 'clases_disponibilidad', forma: 'legacy' },
    [7],
    { ahora: new Date('2026-11-22T02:30:00.000Z'), zonaPorClaseId: { 7: BA } },
  );
  assert.equal(salida['7'].length, 1, 'la fila sin hora no produce ocurrencia');
  assert.equal(salida['7'][0].fecha, '2030-01-10');
  assert.equal(salida['7'][0].recurrente, false);
  assert.ok(consultas[0].filtros.some(([op, col, value]) => op === 'gte' && col === 'fecha' && value === '2026-11-21'));
});

test('cargarHorariosPorClase no convierte error de lectura en vacío', async () => {
  const columnas = { clases_horarios: ['id', 'clase_id', 'dia_semana', 'hora_inicio', 'hora_fin'] };
  const clienteError = fakeCliente({
    columnasPorTabla: columnas,
    falla: { code: '57P01', message: 'terminating connection' },
  });
  await assert.rejects(
    () => cargarHorariosPorClase(clienteError, { tabla: 'clases_horarios', forma: 'recurrente' }, [7], {
      ahora: new Date('2026-11-22T02:30:00.000Z'),
      zonaPorClaseId: { 7: BA },
    }),
    (error) => error.code === CODIGO_HORARIOS_UNAVAILABLE,
  );

  const clienteLanza = fakeCliente({
    columnasPorTabla: columnas,
    lanzar: new Error('socket hang up'),
  });
  await assert.rejects(
    () => cargarHorariosPorClase(clienteLanza, { tabla: 'clases_horarios', forma: 'recurrente' }, [7], {
      ahora: new Date('2026-11-22T02:30:00.000Z'),
      zonaPorClaseId: { 7: BA },
    }),
    (error) => error.code === CODIGO_HORARIOS_UNAVAILABLE,
  );
});

test('cargarHorariosPorClase exige zona de sede válida (sin fallback silencioso)', async () => {
  const cliente = fakeCliente({
    columnasPorTabla: { clases_horarios: ['id', 'clase_id', 'dia_semana', 'hora_inicio', 'hora_fin'] },
    filas: [{ id: 1, clase_id: 7, dia_semana: 0, hora_inicio: '09:00:00', hora_fin: '10:00:00' }],
  });
  for (const zona of [null, '', '   ', 'Marte/Olympus']) {
    await assert.rejects(
      () => cargarHorariosPorClase(cliente, { tabla: 'clases_horarios', forma: 'recurrente' }, [7], {
        ahora: new Date('2026-11-22T02:30:00.000Z'),
        zonaPorClaseId: { 7: zona },
      }),
      (error) => error.code === CODIGO_SEDE_TIMEZONE_INVALIDA,
      `zona ${JSON.stringify(zona)} debe pedir revisión`,
    );
  }
});

test('zonaValida/motivoZonaInvalida clasifican ausente e inválida', () => {
  assert.equal(zonaValida(BA), BA);
  assert.equal(zonaValida('  Pacific/Kiritimati '), KIRITIMATI);
  assert.equal(zonaValida(null), null);
  assert.equal(zonaValida(''), null);
  assert.equal(zonaValida('Marte/Olympus'), null);
  assert.equal(motivoZonaInvalida(null), 'ausente');
  assert.equal(motivoZonaInvalida(''), 'ausente');
  assert.equal(motivoZonaInvalida('Marte/Olympus'), 'invalida');
  assert.equal(motivoZonaInvalida(BA), null);

  assert.throws(
    () => fechaHoraEnZona(new Date('2026-11-22T02:30:00.000Z'), 'Marte/Olympus'),
    (error) => error.code === CODIGO_SEDE_TIMEZONE_INVALIDA,
  );
});

test('reloj por zona es independiente de la TZ del proceso', () => {
  const instante = new Date('2026-11-22T02:30:00.000Z');
  assert.equal(hoyEnZona(instante, BA), '2026-11-21');
  assert.equal(horaEnZona(instante, BA), '23:30');
  assert.equal(hoyEnZona(instante, KIRITIMATI), '2026-11-22');
  assert.equal(horaEnZona(instante, KIRITIMATI), '16:30');
});
