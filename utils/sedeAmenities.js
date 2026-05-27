const SEDE_AMENITY_KEYS = new Set([
  'vestuarios',
  'duchas',
  'gimnasio',
  'buffet',
  'restaurante',
  'estacionamiento',
  'accesibilidad',
  'wifi',
  'camaras_seguridad',
  'iluminacion_led',
  'aire_acondicionado',
  'pro_shop',
  'alquiler_equipamiento',
  'clases_profesores',
  'area_infantil',
  'transporte_publico',
]);

const AMENITY_ALIASES = {
  camaras: 'camaras_seguridad',
  camaras_de_seguridad: 'camaras_seguridad',
  iluminacion: 'iluminacion_led',
  proshop: 'pro_shop',
  alquiler: 'alquiler_equipamiento',
  clases: 'clases_profesores',
  infantil: 'area_infantil',
  transporte: 'transporte_publico',
  parking: 'estacionamiento',
};

function normalizeKey(value) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');

  if (!key) return null;
  if (SEDE_AMENITY_KEYS.has(key)) return key;
  return AMENITY_ALIASES[key] ?? null;
}

export function normalizeSedeAmenities(raw) {
  if (!raw) return [];

  const keys = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const key = normalizeKey(item);
      if (key) keys.push(key);
    }
  } else if (typeof raw === 'object') {
    for (const [name, enabled] of Object.entries(raw)) {
      if (!enabled) continue;
      const key = normalizeKey(name);
      if (key) keys.push(key);
    }
  }

  return [...new Set(keys)];
}
