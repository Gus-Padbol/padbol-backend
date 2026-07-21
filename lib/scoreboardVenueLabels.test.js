import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScoreboardVenueLabels,
  extractCourtNumber,
  formatScoreboardVenueHeader,
  isDemoCourtPlaceholder,
  resolveScoreboardCanchaLabel,
  resolveScoreboardSedeLabel,
} from './scoreboardVenueLabels.js';

describe('scoreboardVenueLabels', () => {
  it('detecta Court One como placeholder demo', () => {
    assert.equal(isDemoCourtPlaceholder('Court One'), true);
    assert.equal(isDemoCourtPlaceholder('Cancha 1'), false);
  });

  it('extrae número desde Court One / Cancha 1 / 1', () => {
    assert.equal(extractCourtNumber('Court One'), 1);
    assert.equal(extractCourtNumber('Cancha 1'), 1);
    assert.equal(extractCourtNumber('2'), 2);
  });

  it('prioriza cancha_nombre real sobre Court One', () => {
    const label = resolveScoreboardCanchaLabel({
      cancha: 'Court One',
      cancha_nombre: 'Cancha 1',
    });
    assert.equal(label, 'Cancha 1');
  });

  it('resuelve Court One contra relación canchas de la sede', () => {
    const label = resolveScoreboardCanchaLabel(
      { cancha: 'Court One', sede_id: 1 },
      { canchas: [{ id: 10, nombre: 'Cancha 1', orden: 1 }] },
    );
    assert.equal(label, 'Cancha 1');
  });

  it('normaliza Court One a Cancha 1 sin relación', () => {
    assert.equal(resolveScoreboardCanchaLabel({ cancha: 'Court One' }), 'Cancha 1');
  });

  it('fallback Cancha si falta nombre', () => {
    assert.equal(resolveScoreboardCanchaLabel({}), 'Cancha');
    assert.equal(resolveScoreboardCanchaLabel({ cancha: null }), 'Cancha');
  });

  it('sede usa nombre real y nunca Sede #id', () => {
    assert.equal(
      resolveScoreboardSedeLabel({ sede_id: 1, sede_nombre: 'La Meca' }),
      'La Meca',
    );
    assert.equal(resolveScoreboardSedeLabel({ sede_id: 1 }), null);
    assert.equal(resolveScoreboardSedeLabel({ sede_nombre: 'Sede #1' }), null);
  });

  it('header completo Cancha 1 · La Meca', () => {
    const header = formatScoreboardVenueHeader({
      cancha: 'Court One',
      sede_id: 1,
      sede_nombre: 'La Meca',
    });
    assert.equal(header, 'Cancha 1 · La Meca');
  });

  it('header oculta sede si no hay nombre real', () => {
    assert.equal(
      formatScoreboardVenueHeader({ cancha: 'Cancha 1', sede_id: 1 }),
      'Cancha 1',
    );
  });

  it('applyScoreboardVenueLabels escribe campos públicos', () => {
    const out = applyScoreboardVenueLabels({
      id: 'x',
      cancha: 'Court One',
      sede_id: 1,
    }, { sedeNombre: 'La Meca' });
    assert.equal(out.cancha_nombre, 'Cancha 1');
    assert.equal(out.sede_nombre, 'La Meca');
    assert.equal(formatScoreboardVenueHeader(out), 'Cancha 1 · La Meca');
  });
});
