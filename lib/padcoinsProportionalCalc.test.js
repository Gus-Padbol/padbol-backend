import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculatePadcoinsForPaidAmount,
  PADCOINS_RESERVATION_CALC_MODE,
} from '../src/padcoins/padcoinsGlobalConfigService.js';

describe('calculatePadcoinsForPaidAmount', () => {
  const configMap = {
    porcentaje_devolucion_reserva: 5,
    padcoins_por_usd_equivalente: 100,
  };
  const configTextMap = {
    modo_calculo_reserva: PADCOINS_RESERVATION_CALC_MODE.PERCENTAGE_PAID,
  };

  it('USD 10 → 50 PadCoins (5%, 100/USD)', () => {
    const result = calculatePadcoinsForPaidAmount({
      paidAmount: 10,
      currency: 'USD',
      configMap,
      configTextMap,
    });
    assert.equal(result.applied, true);
    assert.equal(result.padcoins, 50);
  });

  it('USD 50 → 250 PadCoins', () => {
    const result = calculatePadcoinsForPaidAmount({
      paidAmount: 50,
      currency: 'USD',
      configMap,
      configTextMap,
    });
    assert.equal(result.padcoins, 250);
  });

  it('USD 80 → 400 PadCoins', () => {
    const result = calculatePadcoinsForPaidAmount({
      paidAmount: 80,
      currency: 'USD',
      configMap,
      configTextMap,
    });
    assert.equal(result.padcoins, 400);
  });

  it('ARS sin conversión → no aplica automáticamente', () => {
    const result = calculatePadcoinsForPaidAmount({
      paidAmount: 5000,
      currency: 'ARS',
      configMap,
      configTextMap,
    });
    assert.equal(result.applied, false);
    assert.equal(result.padcoins, null);
    assert.match(result.reason, /ARS/);
  });

  it('modo distinto → no aplica', () => {
    const result = calculatePadcoinsForPaidAmount({
      paidAmount: 10,
      currency: 'USD',
      configMap,
      configTextMap: { modo_calculo_reserva: 'fijo' },
    });
    assert.equal(result.applied, false);
    assert.equal(result.padcoins, null);
  });
});
