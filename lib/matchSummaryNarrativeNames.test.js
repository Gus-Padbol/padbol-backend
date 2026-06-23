import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveEquipoNarrativeMeta,
  summaryRepeatsGenericTeamsTooMuch,
} from '../src/partidos/matchSummaryNarrativeNames.js';

describe('matchSummaryNarrativeNames', () => {
  it('usa nombre custom cuando no es genérico', () => {
    const meta = resolveEquipoNarrativeMeta(
      { nombre: 'Los Gauchos', jugadores: [{ nombre_display: 'Ana' }] },
      'Equipo 1',
    );

    assert.equal(meta.nombre, 'Los Gauchos');
    assert.equal(meta.tipo, 'custom');
    assert.equal(meta.es_generico, false);
  });

  it('usa dupla cuando hay dos jugadores confiables', () => {
    const meta = resolveEquipoNarrativeMeta(
      {
        nombre: 'Equipo 1',
        jugadores: [
          { nombre_display: 'Nico Renedo' },
          { nombre_display: 'Gustavo Miguens' },
        ],
      },
      'Equipo 1',
    );

    assert.equal(meta.nombre, 'La dupla de Nico Renedo y Gustavo Miguens');
    assert.equal(meta.tipo, 'dupla');
    assert.equal(meta.es_generico, false);
  });

  it('filtra jugadores técnicos al armar dupla', () => {
    const meta = resolveEquipoNarrativeMeta(
      {
        nombre: 'Equipo 1',
        jugadores: [
          { nombre_display: 'padbolmatchsaas' },
          { nombre_display: 'Nico' },
          { nombre_display: 'prueba' },
        ],
      },
      'Equipo 1',
    );

    assert.equal(meta.nombre, 'Equipo 1');
    assert.equal(meta.tipo, 'generico');
  });

  it('detecta repetición excesiva de Equipo 1/2', () => {
    assert.equal(
      summaryRepeatsGenericTeamsTooMuch(
        'Equipo 1 se impuso a Equipo 2 por 2 sets a 1. Equipo 1 cerró mejor que Equipo 2.',
      ),
      true,
    );
    assert.equal(
      summaryRepeatsGenericTeamsTooMuch(
        'Equipo 1 se impuso por 2 sets a 1. La dupla rival reaccionó en el segundo set.',
      ),
      false,
    );
  });
});
