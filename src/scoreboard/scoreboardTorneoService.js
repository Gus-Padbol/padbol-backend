import { resolveJerseyNumber } from '../../utils/scoreboardLogic.js';
import { persistControlTokenForScoreboard } from './scoreboardControlTokenService.js';
import {
  buildControlLinks,
  buildDisplayLinks,
} from './scoreboardLinks.js';

const SCOREBOARD_ACTIVE_ESTADOS_TERMINADOS = new Set(['terminado', 'finalizado']);

const SCOREBOARD_INSERT_SELECT = [
  'id', 'sede_id', 'torneo_id', 'torneo_nombre', 'cancha', 'partido_torneo_id',
  'equipo_a_nombre', 'equipo_b_nombre', 'estado',
].join(', ');

function safeJugadoresArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseGenerarScoreboardsOptions(body = {}) {
  const canchasRotacion = Array.isArray(body.canchas_rotacion)
    ? body.canchas_rotacion.map((c) => String(c ?? '').trim()).filter(Boolean)
    : [];

  return {
    emitir_tokens: body.emitir_tokens !== false,
    reemitir_tokens: body.reemitir_tokens === true,
    cancha_default: body.cancha_default != null && String(body.cancha_default).trim() !== ''
      ? String(body.cancha_default).trim()
      : null,
    canchas_rotacion: canchasRotacion,
  };
}

export function resolveCanchaForPartidoIndex(partido, index, options) {
  const fromPartido = partido?.cancha != null ? String(partido.cancha).trim() : '';
  if (fromPartido) return fromPartido;

  if (options.canchas_rotacion.length > 0) {
    return options.canchas_rotacion[index % options.canchas_rotacion.length];
  }

  return options.cancha_default;
}

export function mapJugadoresForScoreboard(jugadoresRaw) {
  const jugadores = safeJugadoresArray(jugadoresRaw);
  const resolvedJerseys = [1, 2, 3, 4].map((slot, idx) => resolveJerseyNumber(
    jugadores[idx]?.jersey ?? jugadores[idx]?.numero,
    slot,
  ));

  return jugadores.map((j, idx) => ({
    ...j,
    numero: resolvedJerseys[idx],
    jersey: resolvedJerseys[idx],
    nombre: String(j?.nombre ?? j?.name ?? `Jugador ${idx + 1}`).trim() || `Jugador ${idx + 1}`,
  }));
}

function buildScoreboardInsertRow({
  partido,
  torneo,
  equipoA,
  equipoB,
  cancha,
}) {
  const sedeId = partido.sede_id ?? torneo.sede_id ?? null;
  const jugadoresA = mapJugadoresForScoreboard(equipoA?.jugadores);
  const jugadoresB = mapJugadoresForScoreboard(equipoB?.jugadores);
  const resolvedJerseysA = [1, 2, 3, 4].map((slot, idx) => resolveJerseyNumber(
    jugadoresA[idx]?.jersey ?? jugadoresA[idx]?.numero,
    slot,
  ));
  const resolvedJerseysB = [1, 2, 3, 4].map((slot, idx) => resolveJerseyNumber(
    jugadoresB[idx]?.jersey ?? jugadoresB[idx]?.numero,
    slot,
  ));

  return {
    partido_torneo_id: partido.id,
    torneo_id: partido.torneo_id ?? torneo.id,
    torneo_nombre: torneo.nombre ? String(torneo.nombre).trim() : null,
    sede_id: sedeId,
    cancha: cancha || null,
    equipo_a_nombre: String(equipoA?.nombre ?? 'Equipo A').trim() || 'Equipo A',
    equipo_b_nombre: String(equipoB?.nombre ?? 'Equipo B').trim() || 'Equipo B',
    equipo_a_jugadores: jugadoresA,
    equipo_b_jugadores: jugadoresB,
    jersey_a1: resolvedJerseysA[0],
    jersey_a2: resolvedJerseysA[1],
    jersey_a3: resolvedJerseysA[2],
    jersey_a4: resolvedJerseysA[3],
    jersey_b1: resolvedJerseysB[0],
    jersey_b2: resolvedJerseysB[1],
    jersey_b3: resolvedJerseysB[2],
    jersey_b4: resolvedJerseysB[3],
    saque_actual: 'A',
    color_a: '#1a3a6e',
    color_b: '#6e1a1a',
    estado: 'pendiente',
  };
}

function isScoreboardActivo(estado) {
  return !SCOREBOARD_ACTIVE_ESTADOS_TERMINADOS.has(String(estado ?? '').toLowerCase());
}

function buildItemBase({
  partido,
  scoreboard,
  cancha,
  equipoA,
  equipoB,
  status,
  skip_reason,
  existing_note,
}) {
  const sedeId = scoreboard?.sede_id ?? partido.sede_id ?? null;
  const canchaResolved = cancha ?? scoreboard?.cancha ?? partido.cancha ?? null;
  const display = buildDisplayLinks(sedeId, canchaResolved);

  return {
    partido_id: partido.id,
    scoreboard_id: scoreboard?.id ?? null,
    status,
    skip_reason: skip_reason ?? null,
    existing_note: existing_note ?? null,
    cancha: canchaResolved,
    fecha_hora: partido.fecha_hora ?? null,
    equipo_a_nombre: scoreboard?.equipo_a_nombre ?? equipoA?.nombre ?? null,
    equipo_b_nombre: scoreboard?.equipo_b_nombre ?? equipoB?.nombre ?? null,
    display_path: display.display_path,
    display_url: display.display_url,
    control_path: null,
    control_url: null,
    control_token: null,
  };
}

async function attachControlTokenIfNeeded(supabaseAdmin, item, scoreboardId, options, isNew) {
  const shouldIssue = isNew
    ? options.emitir_tokens
    : options.reemitir_tokens;

  if (!shouldIssue || !scoreboardId) {
    if (!isNew && options.emitir_tokens && !options.reemitir_tokens) {
      item.existing_note = item.existing_note || 'scoreboard_already_exists';
    }
    return item;
  }

  const { controlToken } = await persistControlTokenForScoreboard(supabaseAdmin, scoreboardId);
  const control = buildControlLinks(controlToken);
  item.control_path = control.control_path;
  item.control_url = control.control_url;
  item.control_token = controlToken;
  return item;
}

/**
 * Crea scoreboards en lote para partidos de torneo (idempotente).
 */
export async function generarScoreboardsForTorneo(supabaseAdmin, torneoId, body = {}) {
  const tid = parseInt(String(torneoId), 10);
  if (!Number.isFinite(tid) || tid <= 0) {
    throw Object.assign(new Error('ID de torneo inválido'), { status: 400 });
  }

  const options = parseGenerarScoreboardsOptions(body);

  const { data: torneo, error: errTorneo } = await supabaseAdmin
    .from('torneos')
    .select('id, nombre, sede_id')
    .eq('id', tid)
    .single();
  if (errTorneo) throw errTorneo;
  if (!torneo) {
    throw Object.assign(new Error('Torneo no encontrado'), { status: 404 });
  }

  const [{ data: partidos, error: errPartidos }, { data: equipos, error: errEquipos }] = await Promise.all([
    supabaseAdmin
      .from('partidos')
      .select('id, torneo_id, sede_id, cancha, fecha_hora, estado, equipo_a_id, equipo_b_id, grupo, ronda')
      .eq('torneo_id', tid)
      .order('id', { ascending: true }),
    supabaseAdmin
      .from('equipos')
      .select('id, nombre, jugadores')
      .eq('torneo_id', tid),
  ]);

  if (errPartidos) throw errPartidos;
  if (errEquipos) throw errEquipos;

  const equiposMap = new Map((equipos ?? []).map((eq) => [eq.id, eq]));
  const partidoIds = (partidos ?? []).map((p) => p.id).filter((id) => id != null);

  let existingByPartido = new Map();
  if (partidoIds.length > 0) {
    const { data: existingRows, error: errExisting } = await supabaseAdmin
      .from('scoreboard_partidos')
      .select('id, partido_torneo_id, sede_id, cancha, equipo_a_nombre, equipo_b_nombre, estado')
      .in('partido_torneo_id', partidoIds)
      .not('estado', 'in', '(terminado,finalizado)');

    if (errExisting) throw errExisting;

    for (const row of existingRows ?? []) {
      if (row.partido_torneo_id != null && isScoreboardActivo(row.estado)) {
        existingByPartido.set(Number(row.partido_torneo_id), row);
      }
    }
  }

  const items = [];
  let created = 0;
  let skipped = 0;

  for (let index = 0; index < (partidos ?? []).length; index += 1) {
    const partido = partidos[index];
    const equipoA = equiposMap.get(partido.equipo_a_id);
    const equipoB = equiposMap.get(partido.equipo_b_id);

    if (!partido.equipo_a_id || !partido.equipo_b_id || !equipoA || !equipoB) {
      skipped += 1;
      items.push({
        ...buildItemBase({
          partido,
          scoreboard: null,
          cancha: resolveCanchaForPartidoIndex(partido, index, options),
          equipoA,
          equipoB,
          status: 'skipped',
          skip_reason: 'missing_teams',
        }),
      });
      continue;
    }

    const existing = existingByPartido.get(Number(partido.id));
    if (existing) {
      const item = buildItemBase({
        partido,
        scoreboard: existing,
        cancha: existing.cancha,
        equipoA,
        equipoB,
        status: 'existing',
        existing_note: options.reemitir_tokens ? null : 'scoreboard_already_exists',
      });
      await attachControlTokenIfNeeded(supabaseAdmin, item, existing.id, options, false);
      items.push(item);
      continue;
    }

    const cancha = resolveCanchaForPartidoIndex(partido, index, options);
    const insertRow = buildScoreboardInsertRow({
      partido,
      torneo,
      equipoA,
      equipoB,
      cancha,
    });

    const { data: inserted, error: errInsert } = await supabaseAdmin
      .from('scoreboard_partidos')
      .insert(insertRow)
      .select(SCOREBOARD_INSERT_SELECT)
      .limit(1);

    if (errInsert) throw errInsert;

    const scoreboard = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!scoreboard) {
      throw new Error('No se pudo crear el scoreboard para el partido');
    }

    existingByPartido.set(Number(partido.id), scoreboard);
    created += 1;

    const item = buildItemBase({
      partido,
      scoreboard,
      cancha,
      equipoA,
      equipoB,
      status: 'created',
    });
    await attachControlTokenIfNeeded(supabaseAdmin, item, scoreboard.id, options, true);
    items.push(item);
  }

  return {
    ok: true,
    torneo_id: tid,
    created,
    skipped,
    items,
  };
}
