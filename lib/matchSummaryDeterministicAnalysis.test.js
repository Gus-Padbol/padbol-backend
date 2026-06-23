import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMatchSummaryDeterministicAnalysis,
  formatFechaEspanol,
} from '../src/partidos/matchSummaryDeterministicAnalysis.js';

const setsPayload = {
  contexto: {
    sede_nombre: 'La Meca Padbol Club',
    fecha: '2026-06-15',
  },
  equipos: {
    equipo1: { nombre: 'Los Gauchos', jugadores: [{ nombre_display: 'Ana' }] },
    equipo2: { nombre: 'La Meca Team', jugadores: [{ nombre_display: 'Bruno' }] },
  },
  resultado: {
    formato: 'sets',
    ganador: 'equipo1',
    sets: {
      equipo1_sets: 2,
      equipo2_sets: 1,
      sets_detalle: [
        { eq1: 6, eq2: 4 },
        { eq1: 4, eq2: 6 },
        { eq1: 6, eq2: 3 },
      ],
    },
  },
  scoreboard_opcional: {
    cronometro_segundos: 3720,
    duracion_aproximada_minutos: 62,
  },
};

describe('matchSummaryDeterministicAnalysis', () => {
  it('formatFechaEspanol devuelve fecha en español', () => {
    assert.equal(formatFechaEspanol('2026-06-15'), '15 de junio de 2026');
    assert.equal(formatFechaEspanol('2026-01-03'), '3 de enero de 2026');
  });

  it('analiza partido 2-1 con tercer set decisivo y reacción del perdedor', () => {
    const analisis = buildMatchSummaryDeterministicAnalysis(setsPayload);

    assert.equal(analisis.ganador.nombre, 'Los Gauchos');
    assert.equal(analisis.perdedor.nombre, 'La Meca Team');
    assert.equal(analisis.resultado_final_sets.texto, '2-1');
    assert.deepEqual(analisis.parciales, ['6-4', '4-6', '6-3']);
    assert.equal(analisis.fue_2_1, true);
    assert.equal(analisis.fue_2_0, false);
    assert.equal(analisis.tercer_set_decisivo, true);
    assert.equal(analisis.perdedor_reacciono_segundo_set, true);
    assert.equal(analisis.ganador_cerro_fuerte_ultimo_set, true);
    assert.equal(analisis.frases_sugeridas.partido_cambiante, true);
    assert.equal(analisis.frases_sugeridas.partido_ajustado, true);
    assert.equal(analisis.plantilla_fallback, '2_1_ajustado');
    assert.equal(analisis.sede, 'La Meca Padbol Club');
    assert.equal(analisis.fecha_espanol, '15 de junio de 2026');
    assert.equal(analisis.duracion_minutos, 62);
    assert.deepEqual(analisis.equipos.equipo1.jugadores, ['Ana']);
  });

  it('analiza partido 2-0', () => {
    const analisis = buildMatchSummaryDeterministicAnalysis({
      ...setsPayload,
      resultado: {
        formato: 'sets',
        ganador: 'equipo1',
        sets: {
          equipo1_sets: 2,
          equipo2_sets: 0,
          sets_detalle: [{ eq1: 6, eq2: 3 }, { eq1: 6, eq2: 4 }],
        },
      },
    });

    assert.equal(analisis.fue_2_0, true);
    assert.equal(analisis.fue_2_1, false);
    assert.equal(analisis.tercer_set_decisivo, false);
    assert.equal(analisis.plantilla_fallback, '2_0_claro');
    assert.equal(analisis.frases_sugeridas.partido_cambiante, false);
    assert.equal(analisis.frases_sugeridas.dominio_claro, true);
  });

  it('resuelve nombre por jugadores si no hay custom', () => {
    const analisis = buildMatchSummaryDeterministicAnalysis({
      ...setsPayload,
      equipos: {
        equipo1: {
          nombre: 'Equipo 1',
          jugadores: [{ nombre_display: 'Ana' }, { nombre_display: 'Luis' }],
        },
        equipo2: {
          nombre: 'Equipo 2',
          jugadores: [{ nombre_display: 'Bruno' }],
        },
      },
    });

    assert.match(analisis.equipos.equipo1.nombre, /equipo formado por Ana y Luis/i);
    assert.match(analisis.equipos.equipo2.nombre, /equipo formado por Bruno/i);
  });

  it('oculta duración cuando cronometro_segundos es 0', () => {
    const analisis = buildMatchSummaryDeterministicAnalysis({
      ...setsPayload,
      scoreboard_opcional: {
        cronometro_segundos: 0,
        duracion_aproximada_minutos: 0,
      },
    });

    assert.equal(analisis.duracion_minutos, null);
  });

  it('oculta duración cuando cronometro_segundos es null', () => {
    const analisis = buildMatchSummaryDeterministicAnalysis({
      ...setsPayload,
      scoreboard_opcional: {
        cronometro_segundos: null,
        duracion_aproximada_minutos: null,
      },
    });

    assert.equal(analisis.duracion_minutos, null);
  });
});
