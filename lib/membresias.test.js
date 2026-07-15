import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMembresiaBenefitsToQuote,
  assertAdminSedeScope,
  buildMembresiaNotificacionDedupeKey,
  buildPeriodoKey,
  isMembershipActive,
  mapPlanPublico,
  normalizeBeneficios,
  resolveDuracionDias,
  shouldMarkExpired,
} from './membresiasDomain.js';

describe('membresias dominio', () => {
  it('1-3. plan beneficios y duración', () => {
    const bens = normalizeBeneficios({
      descuento_porcentual: 10,
      reservas_incluidas_por_periodo: 4,
      prioridad_horas: 48,
    });
    assert.equal(bens.descuento_porcentual, 10);
    assert.equal(bens.reservas_incluidas_por_periodo, 4);
    assert.ok(bens.aplicables_ahora.includes('descuento_porcentual'));
    assert.ok(bens.informativos.includes('prioridad_horas'));
    assert.equal(resolveDuracionDias({ duracion_tipo: 'mensual' }), 30);
    assert.equal(resolveDuracionDias({ duracion_tipo: 'anual' }), 365);
  });

  it('8. vencimiento lazy', () => {
    const past = {
      estado: 'activa',
      vencimiento: new Date(Date.now() - 60_000).toISOString(),
    };
    assert.equal(shouldMarkExpired(past), true);
    assert.equal(isMembershipActive(past), false);
    const future = {
      estado: 'activa',
      vencimiento: new Date(Date.now() + 86400000).toISOString(),
    };
    assert.equal(isMembershipActive(future), true);
  });

  it('9. admin club restringido a sede', () => {
    assert.equal(assertAdminSedeScope({ rol: 'admin_club', sede_id: 1 }, 1), null);
    assert.equal(assertAdminSedeScope({ rol: 'admin_club', sede_id: 1 }, 2)?.status, 403);
    assert.equal(assertAdminSedeScope({ rol: 'super_admin', sede_id: null }, 99), null);
  });

  it('12-16. descuento, incluida, límite, sin doble descuento', () => {
    const withIncluidas = applyMembresiaBenefitsToQuote({
      base: 1000,
      extrasSubtotal: 100,
      beneficios: { descuento_porcentual: 50, reservas_incluidas_por_periodo: 2 },
      incluidasUsadas: 0,
    });
    assert.equal(withIncluidas.reserva_incluida, true);
    assert.equal(withIncluidas.base, 0);
    assert.equal(withIncluidas.beneficio_aplicado.tipo, 'reservas_incluidas_por_periodo');
    // no aplica también el %
    assert.equal(withIncluidas.descuento_monto, 1000);

    const limitHit = applyMembresiaBenefitsToQuote({
      base: 1000,
      extrasSubtotal: 0,
      beneficios: { descuento_porcentual: 10, reservas_incluidas_por_periodo: 2 },
      incluidasUsadas: 2,
    });
    assert.equal(limitHit.reserva_incluida, false);
    assert.equal(limitHit.beneficio_aplicado.tipo, 'descuento_porcentual');
    assert.equal(limitHit.base, 900);

    const otherSedeConcept = applyMembresiaBenefitsToQuote({
      base: 1000,
      beneficios: {},
      incluidasUsadas: 0,
    });
    assert.equal(otherSedeConcept.beneficio_aplicado, null);
    assert.equal(otherSedeConcept.base, 1000);
  });

  it('17. periodo key estable', () => {
    const mem = {
      id: 7,
      inicio: '2026-01-01T00:00:00.000Z',
      vencimiento: '2026-01-31T00:00:00.000Z',
    };
    const a = buildPeriodoKey(mem, new Date('2026-01-10T12:00:00.000Z'));
    const b = buildPeriodoKey(mem, new Date('2026-01-10T18:00:00.000Z'));
    assert.equal(a, b);
  });

  it('18. dedupe notificaciones', () => {
    const a = buildMembresiaNotificacionDedupeKey('membresia_activada', {
      membresiaId: 1,
      sedeId: 2,
      userId: 'u',
    });
    const b = buildMembresiaNotificacionDedupeKey('membresia_activada', {
      membresiaId: 1,
      sedeId: 2,
      userId: 'u',
    });
    assert.equal(a, b);
  });

  it('19. privacidad plan map', () => {
    const plan = mapPlanPublico({
      id: 1,
      sede_id: 9,
      nombre: 'Gold',
      precio: 1000,
      moneda: 'ARS',
      duracion_tipo: 'mensual',
      duracion_dias: 30,
      activo: true,
      beneficios: { descuento_porcentual: 15 },
      renovacion_automatica: true,
    });
    assert.equal(plan.renovacion_automatica_cobro, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(plan, 'mp_access_token'));
  });
});
