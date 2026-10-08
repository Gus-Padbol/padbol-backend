import { CANCHA_DEPORTE_CRUD_VALID, mapCanchaPublicDto, normalizeCanchaDeporteSlug } from './canchaDeporteCustom.js';

const positiveInt = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
export function normalizeAvailabilitySport(raw) {
  if (raw == null || raw === '') return null;
  const normalized = normalizeCanchaDeporteSlug(raw, { emptyDefault: null });
  const sport = normalized === 'tennis' ? 'tenis' : normalized;
  if (!CANCHA_DEPORTE_CRUD_VALID.has(sport)) {
    throw Object.assign(new Error('Deporte de reserva inválido'), { status: 400 });
  }
  return sport;
}

/** Assign ordinals before filtering: disabled courts must never renumber their neighbours. */
export function buildSedeCourtCatalog(sede, rows = []) {
  const all = rows.filter(row => Number(row.sede_id) === Number(sede.id))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row, index) => ({ ...row, numero: positiveInt(row.orden) ?? index + 1 }));
  const configured = all.length > 0;
  const numberCounts = new Map();
  for (const row of all) numberCounts.set(row.numero, (numberCounts.get(row.numero) || 0) + 1);
  const courts = configured ? all.filter(row => {
    const sport = normalizeCanchaDeporteSlug(row.deporte);
    return CANCHA_DEPORTE_CRUD_VALID.has(sport)
      && !['inactiva', 'inactive', 'false'].includes(String(row.estado).toLowerCase())
      && numberCounts.get(row.numero) === 1;
  }).map(row => {
    const dto = mapCanchaPublicDto(row, { orden: row.numero });
    return { ...dto, numero: row.numero, numero_reserva: row.numero };
  }) : Array.from({ length: positiveInt(sede.cantidad_canchas) ?? 1 }, (_, index) => ({
    id: null, sede_id: Number(sede.id), numero: index + 1, numero_reserva: index + 1,
    nombre: `Cancha ${index + 1}`, deporte: 'padbol', estado: 'activa',
  }));
  const counts = new Map();
  for (const court of courts) counts.set(court.deporte, (counts.get(court.deporte) || 0) + 1);
  return {
    catalogo_canchas_configurado: configured,
    canchas_activas: courts,
    deportes_disponibles: [...counts.keys()],
    canchas_por_deporte: [...counts].map(([deporte, cantidad]) => ({ deporte, cantidad, activo: true })),
  };
}

/** Read only the catalog of venues already selected by the caller's visibility policy. */
export async function enrichSedesWithCourtCatalog(supabaseAdmin, sedes = []) {
  if (!sedes.length) return [];
  const ids = [...new Set(sedes.map(sede => positiveInt(sede.id)).filter(Boolean))];
  const { data, error } = await supabaseAdmin.from('canchas').select('*').in('sede_id', ids).order('id', { ascending: true });
  if (error) throw error; // An unavailable catalog is not evidence of an old Padbol venue.
  return sedes.map(sede => ({ ...sede, ...buildSedeCourtCatalog(sede, data || []) }));
}

export function slotCourtMetadata(court) {
  if (!court) return {};
  return {
    cancha_id: court.id,
    deporte: court.deporte,
    nombre_cancha: court.nombre,
    deporte_label: court.deporte_label,
    deporte_personalizado: court.deporte_personalizado,
    cantidad_jugadores: court.cantidad_jugadores,
    modalidad_custom: court.modalidad_custom,
    duracion_sugerida_min: court.duracion_sugerida_min,
    es_deporte_personalizado: court.es_deporte_personalizado,
  };
}
