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
  'descripcion_larga',
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

/** Columnas de sedes expuestas en GET /api/sedes y GET /api/sedes/:id (incluye surge_activo). */
export const SEDE_APP_SELECT = SEDE_PUBLIC_COLUMNS.filter(
  (col) => col !== 'descripcion_larga',
).join(', ');

export const SEDE_PERFIL_SELECT = SEDE_PUBLIC_COLUMNS.join(', ');

export function pickPublicSedeRow(row) {
  if (!row || typeof row !== 'object') return row ?? null;
  const out = {};
  for (const key of SEDE_PUBLIC_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      out[key] = row[key];
    }
  }
  if (row.hero_foto_url !== undefined) {
    out.hero_foto_url = row.hero_foto_url;
  }
  return out;
}
