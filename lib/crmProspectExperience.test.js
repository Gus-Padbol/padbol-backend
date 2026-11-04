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
