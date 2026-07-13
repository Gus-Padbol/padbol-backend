/** Validez por defecto de un canje pendiente/aprobado (días). */
export const PADCOINS_CANJE_DEFAULT_VALIDEZ_DIAS = 30;

/** Imagen fallback cuando el beneficio no tiene imagen_url. */
export const PADCOINS_PREMIO_IMAGEN_FALLBACK = '/assets/padcoins/beneficio-default.svg';

export const PADCOINS_CANJE_LIMITE_PERIODO = Object.freeze({
  DIA: 'dia',
  SEMANA: 'semana',
  MES: 'mes',
  TOTAL: 'total',
});

export const PADCOINS_CANJE_LIMITE_PERIODOS = Object.freeze(
  Object.values(PADCOINS_CANJE_LIMITE_PERIODO),
);

export const PADCOINS_CANJE_ESTADOS = Object.freeze({
  PENDIENTE: 'pendiente',
  APROBADO: 'aprobado',
  ENTREGADO: 'entregado',
  CANCELADO: 'cancelado',
  VENCIDO: 'vencido',
});

export const PADCOINS_CANJE_ESTADOS_FINALES = new Set([
  PADCOINS_CANJE_ESTADOS.ENTREGADO,
  PADCOINS_CANJE_ESTADOS.CANCELADO,
  PADCOINS_CANJE_ESTADOS.VENCIDO,
]);

export const PADCOINS_CANJE_ENTREGABLE_ESTADOS = new Set([
  PADCOINS_CANJE_ESTADOS.PENDIENTE,
  PADCOINS_CANJE_ESTADOS.APROBADO,
]);

export const PADCOINS_CANJE_CANCELABLE_ESTADOS = new Set([
  PADCOINS_CANJE_ESTADOS.PENDIENTE,
  PADCOINS_CANJE_ESTADOS.APROBADO,
]);

export const PADCOINS_CANJE_VENCIBLE_ESTADOS = new Set([
  PADCOINS_CANJE_ESTADOS.PENDIENTE,
  PADCOINS_CANJE_ESTADOS.APROBADO,
]);

export const PADCOINS_CANJE_QR_PAYLOAD_VERSION = 1;
export const PADCOINS_CANJE_QR_PAYLOAD_TYPE = 'padcoins_canje';
