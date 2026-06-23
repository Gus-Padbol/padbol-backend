export const EQUIPOS_DERIVACION = {
  CAPITAN_MANUAL: 'capitan_manual',
  SORTEO: 'sorteo',
  JOINED_AT_SPLIT: 'joined_at_split',
};

export const DEFAULT_EQUIPO1_NOMBRE = 'Equipo 1';
export const DEFAULT_EQUIPO2_NOMBRE = 'Equipo 2';

export const EQUIPOS_PARTIDO_ESTADOS_PERMITIDOS = new Set(['abierto', 'completo']);
export const EQUIPOS_PARTIDO_ESTADOS_BLOQUEADOS = new Set(['finalizado', 'en_disputa', 'cancelado']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EquiposPartidoError extends Error {
  constructor(message, { status = 400, code = 'EQUIPOS_PARTIDO_ERROR' } = {}) {
    super(message);
    this.name = 'EquiposPartidoError';
    this.status = status;
    this.code = code;
  }
}

export function normalizeEquipoUserIds(ids) {
  if (!Array.isArray(ids)) return [];

  const seen = new Set();
  const out = [];

  for (const raw of ids) {
    const id = String(raw ?? '').trim().toLowerCase();
    if (!id || !UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

function splitBalancedUserIds(userIds) {
  const midpoint = Math.ceil(userIds.length / 2);
  return {
    equipo1: userIds.slice(0, midpoint),
    equipo2: userIds.slice(midpoint),
  };
}

export function sanitizeEquipoNombre(value, fallback = DEFAULT_EQUIPO1_NOMBRE) {
  if (value == null || typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\n\r\t<>]/g, '').trim();
  return cleaned.slice(0, 80) || fallback;
}

export function resolveEquipoNombres(equiposAsignacion) {
  return {
    equipo1_nombre: sanitizeEquipoNombre(
      equiposAsignacion?.equipo1_nombre,
      DEFAULT_EQUIPO1_NOMBRE,
    ),
    equipo2_nombre: sanitizeEquipoNombre(
      equiposAsignacion?.equipo2_nombre,
      DEFAULT_EQUIPO2_NOMBRE,
    ),
  };
}

function applyEquipoNombresToAsignacion(
  asignacion,
  { equipo1Nombre = undefined, equipo2Nombre = undefined } = {},
) {
  const nombres = resolveEquipoNombres({
    ...asignacion,
    ...(equipo1Nombre !== undefined ? { equipo1_nombre: equipo1Nombre } : {}),
    ...(equipo2Nombre !== undefined ? { equipo2_nombre: equipo2Nombre } : {}),
  });

  return {
    ...asignacion,
    equipo1_nombre: nombres.equipo1_nombre,
    equipo2_nombre: nombres.equipo2_nombre,
  };
}

export function shuffleArray(items, randomFn = Math.random) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomFn() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function validateEquiposAsignacion({
  equipo1 = [],
  equipo2 = [],
  participantUserIds = [],
  jugadoresRequeridos = 4,
}) {
  const normalizedEquipo1 = normalizeEquipoUserIds(equipo1);
  const normalizedEquipo2 = normalizeEquipoUserIds(equipo2);
  const participants = normalizeEquipoUserIds(participantUserIds);

  if (participants.length < 2) {
    return { valid: false, error: 'Se necesitan al menos 2 jugadores para definir equipos' };
  }

  if (normalizedEquipo1.length === 0 || normalizedEquipo2.length === 0) {
    return { valid: false, error: 'Cada equipo debe tener al menos un jugador' };
  }

  const assigned = [...normalizedEquipo1, ...normalizedEquipo2];
  if (assigned.length !== new Set(assigned).size) {
    return { valid: false, error: 'Un jugador no puede estar en ambos equipos' };
  }

  const participantSet = new Set(participants);
  for (const userId of assigned) {
    if (!participantSet.has(userId)) {
      return { valid: false, error: 'Todos los jugadores deben pertenecer al partido' };
    }
  }

  if (assigned.length !== participants.length) {
    return { valid: false, error: 'Debés asignar todos los jugadores del partido' };
  }

  const diff = Math.abs(normalizedEquipo1.length - normalizedEquipo2.length);
  if (diff > 1) {
    return { valid: false, error: 'Los equipos deben tener un reparto equilibrado' };
  }

  if (Number(jugadoresRequeridos) === 4 && participants.length === 4) {
    if (normalizedEquipo1.length !== 2 || normalizedEquipo2.length !== 2) {
      return { valid: false, error: 'Para 4 jugadores, cada equipo debe tener 2 jugadores' };
    }
  }

  return {
    valid: true,
    equipo1: normalizedEquipo1,
    equipo2: normalizedEquipo2,
  };
}

export function buildManualEquiposAsignacion({
  equipo1,
  equipo2,
  capitanUserId,
  participantUserIds,
  jugadoresRequeridos = 4,
  equipo1Nombre,
  equipo2Nombre,
  definidoAt = new Date().toISOString(),
}) {
  const validation = validateEquiposAsignacion({
    equipo1,
    equipo2,
    participantUserIds,
    jugadoresRequeridos,
  });

  if (!validation.valid) {
    throw new EquiposPartidoError(validation.error, { code: 'EQUIPOS_VALIDATION_ERROR' });
  }

  if (!capitanUserId) {
    throw new EquiposPartidoError('Capitán inválido', { status: 400, code: 'CAPITAN_INVALIDO' });
  }

  return applyEquipoNombresToAsignacion({
    modo: 'manual',
    equipo1: validation.equipo1,
    equipo2: validation.equipo2,
    definido_por: String(capitanUserId),
    definido_at: definidoAt,
    bloqueado: true,
  }, { equipo1Nombre, equipo2Nombre });
}

export function buildSorteoEquiposAsignacion({
  participantUserIds,
  capitanUserId,
  jugadoresRequeridos = 4,
  randomFn = Math.random,
  equipo1Nombre,
  equipo2Nombre,
  definidoAt = new Date().toISOString(),
}) {
  const participants = normalizeEquipoUserIds(participantUserIds);

  if (participants.length < 2) {
    throw new EquiposPartidoError(
      'Se necesitan al menos 2 jugadores para sortear equipos',
      { code: 'EQUIPOS_SORTEO_INSUFICIENTE' },
    );
  }

  const shuffled = shuffleArray(participants, randomFn);
  const { equipo1, equipo2 } = splitBalancedUserIds(shuffled);

  const validation = validateEquiposAsignacion({
    equipo1,
    equipo2,
    participantUserIds: participants,
    jugadoresRequeridos,
  });

  if (!validation.valid) {
    throw new EquiposPartidoError(validation.error, { code: 'EQUIPOS_SORTEO_INVALIDO' });
  }

  return applyEquipoNombresToAsignacion({
    modo: 'sorteo',
    equipo1: validation.equipo1,
    equipo2: validation.equipo2,
    definido_por: String(capitanUserId),
    definido_at: definidoAt,
    bloqueado: true,
  }, { equipo1Nombre, equipo2Nombre });
}

export function sortJugadoresRowsForEquipos(rows, capitanUserId, capitanEmail) {
  const sorted = [...(rows ?? [])].sort(
    (a, b) => new Date(a.joined_at ?? 0) - new Date(b.joined_at ?? 0),
  );

  if (
    capitanUserId
    && !sorted.some((row) => row.user_id && String(row.user_id) === String(capitanUserId))
  ) {
    sorted.unshift({
      user_id: capitanUserId,
      email: capitanEmail ?? null,
      joined_at: null,
    });
  }

  return sorted;
}

export function isEquiposAsignacionValida(equiposAsignacion) {
  if (!equiposAsignacion || typeof equiposAsignacion !== 'object') return false;
  if (equiposAsignacion.bloqueado !== true) return false;
  if (!['manual', 'sorteo'].includes(equiposAsignacion.modo)) return false;

  const equipo1 = normalizeEquipoUserIds(equiposAsignacion.equipo1);
  const equipo2 = normalizeEquipoUserIds(equiposAsignacion.equipo2);

  return equipo1.length > 0 && equipo2.length > 0;
}

export function mapDerivacionFromModo(modo) {
  if (modo === 'manual') return EQUIPOS_DERIVACION.CAPITAN_MANUAL;
  if (modo === 'sorteo') return EQUIPOS_DERIVACION.SORTEO;
  return EQUIPOS_DERIVACION.JOINED_AT_SPLIT;
}

export function resolveEquiposPartido({
  jugadoresRows = [],
  capitanUserId = null,
  capitanEmail = null,
  equiposAsignacion = null,
  jugadoresRequeridos = 4,
}) {
  const sortedRows = sortJugadoresRowsForEquipos(jugadoresRows, capitanUserId, capitanEmail);
  const rowByUserId = new Map(
    sortedRows
      .filter((row) => row.user_id)
      .map((row) => [String(row.user_id).toLowerCase(), row]),
  );

  if (isEquiposAsignacionValida(equiposAsignacion)) {
    const equipo1Ids = normalizeEquipoUserIds(equiposAsignacion.equipo1);
    const equipo2Ids = normalizeEquipoUserIds(equiposAsignacion.equipo2);
    const derivacion = mapDerivacionFromModo(equiposAsignacion.modo);

    const equipo1Rows = equipo1Ids
      .map((id) => rowByUserId.get(id))
      .filter(Boolean);
    const equipo2Rows = equipo2Ids
      .map((id) => rowByUserId.get(id))
      .filter(Boolean);

    return {
      derivacion,
      equipo1Rows,
      equipo2Rows,
      allRows: [...equipo1Rows, ...equipo2Rows],
      equipos_asignacion: equiposAsignacion,
    };
  }

  void jugadoresRequeridos;

  const midpoint = Math.ceil(sortedRows.length / 2);

  return {
    derivacion: EQUIPOS_DERIVACION.JOINED_AT_SPLIT,
    equipo1Rows: sortedRows.slice(0, midpoint),
    equipo2Rows: sortedRows.slice(midpoint),
    allRows: sortedRows,
    equipos_asignacion: null,
  };
}

export function resolveCapitan2FromEquiposResueltos(resolved, capitanUserId) {
  if (resolved?.equipo2Rows?.length) {
    const capitan2 = resolved.equipo2Rows[0]?.user_id ?? null;
    if (capitan2 && String(capitan2) !== String(capitanUserId)) {
      return capitan2;
    }
    return capitan2;
  }
  return null;
}

export function assertPuedeEditarNombresEquipos(partido) {
  if (!partido) {
    throw new EquiposPartidoError('Partido no encontrado', { status: 404, code: 'PARTIDO_NOT_FOUND' });
  }

  const estado = String(partido.estado ?? '').toLowerCase();

  if (estado === 'finalizado') {
    throw new EquiposPartidoError(
      'No se pueden editar nombres de equipos en un partido finalizado',
      { status: 409, code: 'PARTIDO_FINALIZADO' },
    );
  }

  if (EQUIPOS_PARTIDO_ESTADOS_BLOQUEADOS.has(estado)) {
    throw new EquiposPartidoError(
      'No se pueden editar nombres de equipos en el estado actual del partido',
      { status: 409, code: 'PARTIDO_ESTADO_NO_PERMITIDO' },
    );
  }

  if (!isEquiposAsignacionValida(partido.equipos_asignacion)) {
    throw new EquiposPartidoError(
      'Primero debés definir los equipos',
      { status: 409, code: 'EQUIPOS_NO_DEFINIDOS' },
    );
  }
}

export function assertPuedeDefinirEquipos(partido) {
  if (!partido) {
    throw new EquiposPartidoError('Partido no encontrado', { status: 404, code: 'PARTIDO_NOT_FOUND' });
  }

  const estado = String(partido.estado ?? '').toLowerCase();

  if (EQUIPOS_PARTIDO_ESTADOS_BLOQUEADOS.has(estado)) {
    throw new EquiposPartidoError(
      'No se pueden definir equipos en el estado actual del partido',
      { status: 409, code: 'PARTIDO_ESTADO_NO_PERMITIDO' },
    );
  }

  if (!EQUIPOS_PARTIDO_ESTADOS_PERMITIDOS.has(estado)) {
    throw new EquiposPartidoError(
      'Solo se pueden definir equipos en partidos abiertos o completos',
      { status: 409, code: 'PARTIDO_ESTADO_NO_PERMITIDO' },
    );
  }
}

export async function fetchActiveScoreboardForPartido(supabaseAdmin, partidoId) {
  const { data, error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select('id, estado')
    .eq('partido_abierto_id', partidoId)
    .not('estado', 'in', '(terminado,finalizado)')
    .limit(1);

  if (error) throw error;
  return data?.[0] ?? null;
}

export async function hasActiveScoreboardForPartido(supabaseAdmin, partidoId) {
  const row = await fetchActiveScoreboardForPartido(supabaseAdmin, partidoId);
  return Boolean(row);
}

async function syncScoreboardEquiposNombres(
  supabaseAdmin,
  partidoId,
  { equipo1Nombre, equipo2Nombre },
) {
  const scoreboard = await fetchActiveScoreboardForPartido(supabaseAdmin, partidoId);
  if (!scoreboard) return;

  const { error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .update({
      equipo_a_nombre: equipo1Nombre,
      equipo_b_nombre: equipo2Nombre,
    })
    .eq('id', scoreboard.id);

  if (error) throw error;
}

async function fetchParticipantUserIds(supabaseAdmin, partidoId, capitanUserId) {
  const { data: jugadores, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('user_id')
    .eq('partido_id', partidoId);

  if (error) throw error;

  const ids = normalizeEquipoUserIds((jugadores ?? []).map((row) => row.user_id));

  if (capitanUserId && !ids.includes(String(capitanUserId).toLowerCase())) {
    ids.unshift(String(capitanUserId).toLowerCase());
  }

  return [...new Set(ids)];
}

async function buildEquiposPartidoResponse({
  supabaseAdmin,
  partidoId,
  partido,
  updated,
}) {
  const capitanUserId = updated.capitan_user_id ?? partido.capitan_user_id ?? null;

  const { data: jugadoresRows, error: jugadoresErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('user_id, email, joined_at')
    .eq('partido_id', partidoId)
    .order('joined_at', { ascending: true });

  if (jugadoresErr) throw jugadoresErr;

  const resolved = resolveEquiposPartido({
    jugadoresRows: jugadoresRows ?? [],
    capitanUserId,
    capitanEmail: updated.capitan_email ?? partido.capitan_email ?? null,
    equiposAsignacion: updated.equipos_asignacion,
    jugadoresRequeridos: updated.jugadores_requeridos ?? partido.jugadores_requeridos ?? 4,
  });

  return {
    status: 200,
    body: {
      success: true,
      equipos_asignacion: updated.equipos_asignacion,
      equipos_derivacion: resolved.derivacion,
      equipo1: resolved.equipo1Rows.map((row) => ({
        user_id: row.user_id,
        email: row.email ?? null,
      })),
      equipo2: resolved.equipo2Rows.map((row) => ({
        user_id: row.user_id,
        email: row.email ?? null,
      })),
    },
  };
}

function assertCapitanEquipos(partido, user) {
  const capitanUserId = partido.capitan_user_id ?? null;
  if (!capitanUserId || String(capitanUserId) !== String(user.id)) {
    throw new EquiposPartidoError('Solo el capitán puede definir equipos', {
      status: 403,
      code: 'EQUIPOS_SOLO_CAPITAN',
    });
  }
  return capitanUserId;
}

/**
 * PUT /api/partidos/:id/equipos
 */
export async function procesarActualizarNombresEquiposPartido({
  supabaseAdmin,
  partidoId,
  user,
  body,
}) {
  const { data: partido, error: fetchErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, capitan_email, estado, jugadores_requeridos, equipos_asignacion')
    .eq('id', partidoId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  assertPuedeEditarNombresEquipos(partido);
  assertCapitanEquipos(partido, user);

  const equipo1NombreProvided = body?.equipo1_nombre != null;
  const equipo2NombreProvided = body?.equipo2_nombre != null;

  if (!equipo1NombreProvided && !equipo2NombreProvided) {
    throw new EquiposPartidoError(
      'Debés enviar al menos equipo1_nombre o equipo2_nombre',
      { code: 'EQUIPOS_NOMBRES_REQUERIDOS' },
    );
  }

  const equiposAsignacion = applyEquipoNombresToAsignacion(partido.equipos_asignacion, {
    ...(equipo1NombreProvided ? { equipo1Nombre: body.equipo1_nombre } : {}),
    ...(equipo2NombreProvided ? { equipo2Nombre: body.equipo2_nombre } : {}),
  });

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({ equipos_asignacion: equiposAsignacion })
    .eq('id', partidoId)
    .select('id, capitan_user_id, capitan_email, equipos_asignacion, jugadores_requeridos')
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (!updated) {
    throw new EquiposPartidoError('Partido no encontrado', { status: 404, code: 'PARTIDO_NOT_FOUND' });
  }

  await syncScoreboardEquiposNombres(supabaseAdmin, partidoId, {
    equipo1Nombre: equiposAsignacion.equipo1_nombre,
    equipo2Nombre: equiposAsignacion.equipo2_nombre,
  });

  return buildEquiposPartidoResponse({
    supabaseAdmin,
    partidoId,
    partido,
    updated,
  });
}

export async function procesarDefinirEquiposPartido({
  supabaseAdmin,
  partidoId,
  user,
  body,
  randomFn = Math.random,
}) {
  const modoRaw = body?.modo;
  const hasModo = modoRaw != null && String(modoRaw).trim() !== '';
  const hasNombreFields = body?.equipo1_nombre != null || body?.equipo2_nombre != null;

  if (!hasModo && hasNombreFields) {
    return procesarActualizarNombresEquiposPartido({
      supabaseAdmin,
      partidoId,
      user,
      body,
    });
  }

  const { data: partido, error: fetchErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, capitan_email, estado, jugadores_requeridos, equipos_asignacion')
    .eq('id', partidoId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  assertPuedeDefinirEquipos(partido);

  const capitanUserId = assertCapitanEquipos(partido, user);

  if (await hasActiveScoreboardForPartido(supabaseAdmin, partidoId)) {
    throw new EquiposPartidoError(
      'No se pueden definir equipos con un marcador activo vinculado',
      { status: 409, code: 'EQUIPOS_SCOREBOARD_ACTIVO' },
    );
  }

  const participantUserIds = await fetchParticipantUserIds(
    supabaseAdmin,
    partidoId,
    capitanUserId,
  );

  const modo = String(modoRaw ?? '').trim().toLowerCase();
  let equiposAsignacion;

  if (modo === 'manual') {
    equiposAsignacion = buildManualEquiposAsignacion({
      equipo1: body?.equipo1,
      equipo2: body?.equipo2,
      capitanUserId,
      participantUserIds,
      jugadoresRequeridos: partido.jugadores_requeridos ?? 4,
      equipo1Nombre: body?.equipo1_nombre,
      equipo2Nombre: body?.equipo2_nombre,
    });
  } else if (modo === 'sorteo') {
    equiposAsignacion = buildSorteoEquiposAsignacion({
      participantUserIds,
      capitanUserId,
      jugadoresRequeridos: partido.jugadores_requeridos ?? 4,
      randomFn,
      equipo1Nombre: body?.equipo1_nombre,
      equipo2Nombre: body?.equipo2_nombre,
    });
  } else {
    throw new EquiposPartidoError('modo debe ser "manual" o "sorteo"', {
      code: 'EQUIPOS_MODO_INVALIDO',
    });
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({ equipos_asignacion: equiposAsignacion })
    .eq('id', partidoId)
    .select('id, capitan_user_id, capitan_email, equipos_asignacion, jugadores_requeridos')
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (!updated) {
    throw new EquiposPartidoError('Partido no encontrado', { status: 404, code: 'PARTIDO_NOT_FOUND' });
  }

  return buildEquiposPartidoResponse({
    supabaseAdmin,
    partidoId,
    partido,
    updated,
  });
}
