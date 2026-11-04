import assert from 'node:assert/strict';
import test from 'node:test';
import { simulationSummary } from './crmInboundRoutes.js';

const valid = { courts: 2, pricePerHour: 45, availableHours: 12, operatingDays: 30, occupancy: 65.5, otherRevenue: 800, operatingCosts: 4000, initialInvestment: 120000, currency: 'USD', scenario: 'optimistic' };

test('recalcula la simulación desde insumos y no la presenta como oferta', () => {
  const summary = simulationSummary(valid, 'es');
  assert.match(summary, /Simulación orientativa/);
  assert.match(summary, /supuestos declarados/);
  assert.match(summary, /2 cancha/);
  assert.match(summary, /65,5%/);
  assert.match(summary, /optimista/);
  assert.match(summary, /recuperación simple/);
  assert.doesNotMatch(summary, /optimistic|garantía|rentabilidad asegurada/i);
});

test('preserva resultados negativos y omite simulaciones incompletas', () => {
  const loss = simulationSummary({ ...valid, pricePerHour: 10, occupancy: 10, otherRevenue: 0, operatingCosts: 5000 }, 'es');
  assert.match(loss, /-USD|USD -/);
  assert.equal(simulationSummary(null), '');
  assert.equal(simulationSummary({ occupancy: 50 }), '');
  assert.equal(simulationSummary({ ...valid, occupancy: 120 }), '');
});

test('english summary uses translated labels', () => {
  const summary = simulationSummary(valid, 'en');
  assert.match(summary, /Indicative simulation/);
  assert.match(summary, /optimistic scenario/);
  assert.match(summary, /not an offer/);
});

test('resume la simulación comercial v2 por canchas y agenda', () => {
  const value = { type: 'business-v2', currency: 'USD', budget: 75000, courts: 2, referencePerCourt: 25000,
    complements: [{ key: 'buffet', label: 'Buffet', budget: 5000, pending: false }],
    activities: [{ period: 'morning', label: 'Colegios', start: '09:00', end: '12:00', days: 4, rate: 30 },
      { period: 'evening', label: 'Alquiler', start: '19:00', end: '23:00', days: 4, rate: 50 }],
    complementaryMode: 'percent', complementaryPercent: 10 };
  const summary = simulationSummary(value, 'es');
  assert.match(summary, /Simulación comercial/);
  assert.match(summary, /2 cancha/);
  assert.match(summary, /75.000/);
  assert.match(summary, /facturación complementaria/);
  assert.match(summary, /no es una oferta/);
  assert.match(summary, /recuperación bruta/);
});

test('no suma agendas superpuestas en la simulación v2', () => {
  const value = { type: 'business-v2', currency: 'USD', budget: 50000, courts: 1, referencePerCourt: 25000,
    activities: [{ start: '09:00', end: '12:00', days: 4, rate: 30 }, { start: '10:00', end: '11:00', days: 4, rate: 40 }] };
  assert.equal(simulationSummary(value, 'es'), '');
});
