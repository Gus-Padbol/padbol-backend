const SPORTS = new Set(['padbol', 'padel', 'pickleball', 'tenis']);

function invalid(message, code = 'PARTIDO_FORMATO_INVALIDO', status = 400) {
  return Object.assign(new Error(message), { status, code });
}

export function normalizeMatchSport(raw, fallback = 'padbol') {
  const value = String(raw ?? fallback).trim().toLowerCase();
  const sport = value === 'pádel' ? 'padel' : value === 'tennis' ? 'tenis' : value;
  if (!SPORTS.has(sport)) throw invalid('Deporte no admitido para este encuentro', 'PARTIDO_DEPORTE_INVALIDO');
  return sport;
}

function normalizeFormat(raw) {
  const value = String(raw).trim().toLowerCase();
  if (value === '1v1' || value === 'singles') return '1v1';
  if (value === '2v2' || value === 'dobles' || value === 'dupla') return '2v2';
  throw invalid('Formato de juego inválido');
}

/** Two/four players are the persisted format for daily matches; no schema change. */
export function resolvePartidoSportFormat(body = {}) {
  const deporte = normalizeMatchSport(body.deporte);
  const formats = [body.formato_juego, body.formato_equipo]
    .filter((value) => value != null && value !== '')
    .map(normalizeFormat);
  if (new Set(formats).size > 1) throw invalid('Los formatos de juego no coinciden');
  const rawCount = body.jugadores_requeridos;
  const hasCount = rawCount != null && rawCount !== '';
  const count = hasCount && ['string', 'number'].includes(typeof rawCount) ? Number(rawCount) : null;
  if (hasCount && ![2, 4].includes(count)) throw invalid('El encuentro debe tener 2 o 4 jugadores');
  const formato_juego = formats[0] ?? (count === 2 ? '1v1' : '2v2');
  const jugadores_requeridos = formato_juego === '1v1' ? 2 : 4;
  if (hasCount && count !== jugadores_requeridos) throw invalid('El cupo no coincide con el formato de juego');
  if (['padbol', 'padel'].includes(deporte) && formato_juego !== '2v2') {
    throw invalid('Padbol y Pádel requieren 4 jugadores en dobles');
  }
  return { deporte, formato_juego, jugadores_requeridos };
}

function positiveInt(raw) {
  if (!['string', 'number'].includes(typeof raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** cancha_id remains the legacy ordinal. cancha_registro_id is an explicit DB PK. */
export async function resolvePartidoCourtContract(supabaseAdmin, { sede, body = {}, legacyCourtNumber }) {
  const sedeId = positiveInt(sede?.id);
  if (!sedeId) throw invalid('Sede inválida', 'PARTIDO_SEDE_INVALIDA');
  if (body.sede_id != null && positiveInt(body.sede_id) !== sedeId) {
    throw invalid('La sede solicitada no coincide', 'PARTIDO_SEDE_INVALIDA');
  }
  const { data, error } = await supabaseAdmin.from('canchas').select('*')
    .eq('sede_id', sedeId).order('id', { ascending: true });
  if (error) throw error;
  const rows = [...(data ?? [])].sort((a, b) => Number(a.id) - Number(b.id)).map((row, index) => ({
    ...row, numero: positiveInt(row.orden) ?? index + 1,
  }));
  const hasRegistryId = body.cancha_registro_id != null && body.cancha_registro_id !== '';
  const registryId = hasRegistryId ? positiveInt(body.cancha_registro_id) : null;
  if (hasRegistryId && !registryId) throw invalid('Identificador de cancha inválido', 'PARTIDO_CANCHA_INVALIDA');
  const ordinal = positiveInt(legacyCourtNumber);
  if (!ordinal) throw invalid('Número de cancha inválido', 'PARTIDO_CANCHA_INVALIDA');
  if (body.cancha_id != null && body.cancha_id !== '' && positiveInt(body.cancha_id) !== ordinal) {
    throw invalid('Número de cancha inválido', 'PARTIDO_CANCHA_INVALIDA');
  }

  if (!rows.length) {
    // Existing Padbol venues used cantidad_canchas before there was a court catalog.
    // Never infer a new sport or a registered court from unverified client values.
    if (hasRegistryId || (body.deporte != null && normalizeMatchSport(body.deporte) !== 'padbol')) {
      throw invalid('La sede debe registrar una cancha de ese deporte', 'PARTIDO_CANCHA_NO_CONFIGURADA', 409);
    }
    const { data: legacySede, error: legacyError } = await supabaseAdmin.from('sedes')
      .select('id, cantidad_canchas').eq('id', sedeId).maybeSingle();
    if (legacyError) throw legacyError;
    if (!legacySede || ordinal > (positiveInt(legacySede.cantidad_canchas) ?? 1)) {
      throw invalid('La cancha no pertenece a la sede', 'PARTIDO_CANCHA_INVALIDA');
    }
    return { ...resolvePartidoSportFormat({ ...body, deporte: 'padbol' }), canchaId: null, numero: ordinal, nombre: `Cancha ${ordinal}`, legacy: true };
  }

  const matches = hasRegistryId
    ? rows.filter((row) => Number(row.id) === registryId)
    : rows.filter((row) => row.numero === ordinal);
  if (matches.length !== 1 || Number(matches[0].sede_id) !== sedeId) {
    throw invalid('La cancha no pertenece a la sede o su número es ambiguo', 'PARTIDO_CANCHA_INVALIDA');
  }
  const court = matches[0];
  if (court.numero !== ordinal) throw invalid('El número y el registro de cancha no coinciden', 'PARTIDO_CANCHA_INVALIDA');
  if (['inactiva', 'inactive', 'false'].includes(String(court.estado).toLowerCase())) {
    throw invalid('La cancha no está activa', 'PARTIDO_CANCHA_INACTIVA', 409);
  }
  const deporte = normalizeMatchSport(court.deporte);
  if (body.deporte != null && normalizeMatchSport(body.deporte) !== deporte) {
    throw invalid('La cancha seleccionada corresponde a otro deporte', 'PARTIDO_CANCHA_DEPORTE_NO_COINCIDE');
  }
  return { ...resolvePartidoSportFormat({ ...body, deporte }), canchaId: Number(court.id), numero: court.numero, nombre: court.nombre || `Cancha ${court.numero}`, legacy: false };
}
