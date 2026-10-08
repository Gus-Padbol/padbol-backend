/** Columnas públicas de sedes (sin tokens MP/Stripe ni secretos). */
export const SEDE_PUBLIC_COLUMNS = [
  'id',
  'nombre',
  'direccion',
  'ciudad',
  'provincia',
  'pais',
  'telefono',
  'email_contacto',
  'horario_apertura',
  'horario_cierre',
  'moneda',
  'metodo_pago',
  'pago_manual_instrucciones',
  'precio_60min',
  'precio_90min',
  'precio_120min',
  'precio_turno',
  'precio_por_reserva',
  'cantidad_canchas',
  'duracion_reserva_minutos',
  'latitud',
  'longitud',
  'foto_url',
  'foto_portada',
  'fotos_urls',
  'fotos_destacadas',
  'logo_url',
  'descripcion',
  'slogan',
  'historia',
  'amenities',
  'deportes_disponibles',
  'instagram',
  'facebook',
  'tiktok',
  'twitter',
  'youtube',
  'website',
  'color_fondo_logo',
  'color_hero_primario',
  'color_hero_secundario',
  'color_borde_hero',
  'surge_activo',
  'surge_precio_minimo',
  'surge_precio_maximo',
];

/** Columnas de sedes expuestas en GET /api/sedes, GET /api/sedes/:id y perfil (sin secretos). */
export const SEDE_APP_SELECT = SEDE_PUBLIC_COLUMNS.join(', ');

export const SEDE_PERFIL_SELECT = SEDE_APP_SELECT;
// Only the authorized server uses this projection. Always map before returning.
export const SEDE_PAYMENT_STATUS_SELECT = `${SEDE_APP_SELECT}, mp_access_token, stripe_account_id`;

/**
 * Patrón de nombres de campos que NUNCA deben salir en una respuesta de sede
 * (tokens, secretos y credenciales de pago). Se usa como red de seguridad en
 * tests además del whitelist de SEDE_PUBLIC_COLUMNS.
 */
export const SEDE_SECRET_FIELD_PATTERN = /(token|secret|api_key|apikey|private|credencial|credential|password|client_id)/i;

const PAYMENT_INDICATOR_KEYS = new Set(['mercadopago_configurado', 'stripe_configurado']);
export function isPrivateSedeKey(key) {
  return !PAYMENT_INDICATOR_KEYS.has(key) && (
    SEDE_SECRET_FIELD_PATTERN.test(key) || /^(mp_|mercadopago_|stripe_)/i.test(key)
  );
}

/** Strip private keys at every depth; keep administrative workflow fields. */
export function stripPrivateSedeValues(value) {
  if (Array.isArray(value)) return value.map(stripPrivateSedeValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isPrivateSedeKey(key))
    .map(([key, item]) => [key, stripPrivateSedeValues(item)]));
}


/**
 * Indicadores booleanos no sensibles de configuración de pagos.
 * Nunca devuelve el valor del secreto ni una parte/máscara de él.
 */
export function buildSedePagosIndicadores(row) {
  const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
  return {
    mercadopago_configurado: hasText(row?.mp_access_token),
    stripe_configurado: hasText(row?.stripe_account_id),
  };
}

/**
 * Sanitizador central de sede para respuestas HTTP: whitelist de columnas
 * públicas. Cualquier campo sensible (mp_access_token, stripe_*, secretos)
 * queda excluido por no estar en SEDE_PUBLIC_COLUMNS.
 */
export function pickPublicSedeRow(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  const out = {};
  for (const key of SEDE_PUBLIC_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      out[key] = stripPrivateSedeValues(row[key]);
    }
  }
  if (row.hero_foto_url !== undefined) {
    out.hero_foto_url = row.hero_foto_url;
  }
  return out;
}

export function pickPublicSedeWithPaymentStatus(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  return { ...pickPublicSedeRow(row), ...buildSedePagosIndicadores(row) };
}

/** Admin pending rows keep their workflow fields, never stored payment values. */
export function redactSedePaymentValues(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  return { ...stripPrivateSedeValues(row), ...buildSedePagosIndicadores(row) };
}
