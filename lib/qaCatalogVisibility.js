import { resolveTorneoAdminAccess } from './torneos/torneoAdminAccessService.js';

export function canReadQaCatalogRow(row, audience) {
  return row?.es_prueba !== true || resolveTorneoAdminAccess(audience, Object.hasOwn(row, 'sede_id') ? row.sede_id : row.id).allowed;
}

/** Operational configuration remains in authenticated administrative endpoints. */
export function pickPlayerSedeSummary(row) {
  const { mercadopago_configurado, stripe_configurado, surge_precio_minimo, surge_precio_maximo, pago_manual_instrucciones, es_prueba, ...visible } = row;
  return visible;
}
