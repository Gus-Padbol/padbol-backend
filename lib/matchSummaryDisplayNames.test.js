import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTrustworthyPlayerDisplayName,
  summaryContainsAdministrativeLanguage,
  summaryContainsUntrustworthyIdentifiers,
} from '../src/partidos/matchSummaryDisplayNames.js';

describe('matchSummaryDisplayNames', () => {
  it('rechaza usernames técnicos y cuentas de prueba', () => {
    assert.equal(isTrustworthyPlayerDisplayName('padbolmatchsaas'), false);
    assert.equal(isTrustworthyPlayerDisplayName('prueba'), false);
    assert.equal(isTrustworthyPlayerDisplayName('padbolinternacional'), false);
    assert.equal(isTrustworthyPlayerDisplayName('test123456'), false);
    assert.equal(isTrustworthyPlayerDisplayName('user@mail.com'), false);
    assert.equal(isTrustworthyPlayerDisplayName('Nico'), true);
    assert.equal(isTrustworthyPlayerDisplayName('Gus'), true);
    assert.equal(isTrustworthyPlayerDisplayName('Ana López'), true);
  });

  it('detecta lenguaje administrativo', () => {
    assert.equal(
      summaryContainsAdministrativeLanguage('El resultado fue confirmado por ambos capitanes.'),
      true,
    );
    assert.equal(
      summaryContainsAdministrativeLanguage('Equipo 1 se impuso por 2 sets a 1.'),
      false,
    );
  });

  it('detecta identificadores no deportivos en summary', () => {
    const payload = {
      equipos: {
        equipo1: { jugadores: [{ nombre_display: 'padbolmatchsaas' }, { nombre_display: 'Nico' }] },
        equipo2: { jugadores: [{ nombre_display: 'prueba' }, { nombre_display: 'Gus' }] },
      },
    };

    assert.equal(
      summaryContainsUntrustworthyIdentifiers(
        'El equipo formado por padbolmatchsaas y Nico ganó.',
        payload,
      ),
      true,
    );
    assert.equal(
      summaryContainsUntrustworthyIdentifiers(
        'Equipo 1 se impuso a Equipo 2 por 2 sets a 1 con parciales 6-4, 4-6 y 6-3.',
        payload,
      ),
      false,
    );
  });
});
