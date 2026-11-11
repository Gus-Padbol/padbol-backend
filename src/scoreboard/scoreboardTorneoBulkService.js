import { resolveJerseyNumber } from '../../utils/scoreboardLogic.js';
import { generateControlToken, hashControlToken } from './scoreboardControlToken.js';
import { lineupRosterPlayers } from '../../lib/nationalTeamLineup.js';
import { resolveTorneoAdminAccess } from '../../lib/torneos/torneoAdminAccessService.js';
import {
  buildControlLinks,
  buildDisplayLinks,
} from './scoreboardLinks.js';

// Estados de partido para los que nunca se debe crear un scoreboard nuevo.
const PARTIDO_ESTADOS_NO_JUGABLES = new Set([
  'finalizado', 'finalizada',
  'terminado', 'terminada',
  'cancelado', 'cancelada',
  'suspendido', 'suspendida',
]);

export const SCOREBOARD_INSERT_SELECT = [
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

export function buildScoreboardInsertRow({
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

// Un partido es jugable si no está finalizado/terminado/cancelado.
// Estado ausente (null/undefined) se considera jugable por compatibilidad.
export function isPartidoEstadoJugable(estado) {
  return !PARTIDO_ESTADOS_NO_JUGABLES.has(String(estado ?? '').trim().toLowerCase());
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
    ...buildControlLinks(scoreboard?.id ?? null),
    control_token: null,
  };
}

function bulkError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function declaredRosterTeam(team) {
  const players = lineupRosterPlayers(team).filter(player => ['confirmado','aceptado'].includes(String(player.estado || 'confirmado').toLowerCase()));
  const ids = players.map(player => player.id);
  if (players.length < 2 || players.length > 4 || new Set(ids).size !== ids.length
    || players.some(player => !String(player.nombre || '').trim())) {
    throw bulkError('El plantel confirmado debe tener entre 2 y 4 jugadores identificados', 409, 'national_roster_incomplete');
  }
  return { ...team, jugadores: players };
}

function bulkItem({ partido, scoreboard, canchaPrevista, equipoA, equipoB, status, skip_reason }) {
  // An estimated court is not a live screen claim. Never label its URL as live.
  const effective = scoreboard?.cancha ?? null;
  const item = buildItemBase({ partido: { ...partido, cancha: null }, scoreboard,
    cancha: effective, equipoA, equipoB, status, skip_reason });
  const expected = scoreboard ? buildDisplayLinks(scoreboard.sede_id ?? partido.sede_id, canchaPrevista) : { display_path: null, display_url: null };
  const requiresActivation = Boolean(scoreboard && scoreboard.estado === 'pendiente' && !effective);
  return { ...item, cancha: effective, cancha_prevista: canchaPrevista,
    expected_display_path: expected.display_path, expected_display_url: expected.display_url,
    requires_activation: requiresActivation,
    scoreboard_estado: scoreboard?.estado ?? null,
    estado_preparacion: requiresActivation ? 'pendiente_activacion' : effective ? 'cancha_asignada' : scoreboard ? 'requiere_revision' : null,
    activation_path: requiresActivation ? `/api/torneos/${partido.torneo_id}/partidos/${partido.id}/marcador` : null,
    activation_instruction: requiresActivation
      ? 'Desde el cruce del torneo, elige una cancha y pulsa «Abrir marcador ahora». Después confirma «Iniciar partido» en el control.' : null,
  };
}

/**
 * Bulk preparation uses the existing SQL connection, never a service-key write
 * after an unlocked authorization read. No remote RPC or permission is added.
 * The tournament lock serializes retries; row locks preserve scope and rosters.
 * A savepoint makes each item (including its token) atomic while preserving the
 * useful committed report for other items. A failed COMMIT is never called success.
 */
export async function generarScoreboardsForTorneoBulk(pool, torneoId, body = {}, auth) {
  const tid = Number(torneoId);
  if (!Number.isSafeInteger(tid) || tid <= 0) throw bulkError('ID de torneo inválido', 400, 'INVALID_TOURNAMENT_ID');
  if (!auth?.user?.id) throw bulkError('No autorizado', 401, 'AUTH_REQUIRED');
  if (!pool?.connect) throw bulkError('Preparación temporalmente no disponible', 503, 'BULK_TRANSACTION_UNAVAILABLE');
  const options = parseGenerarScoreboardsOptions(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const torneo = (await client.query(
      'SELECT id,nombre,sede_id,modalidad_plantel,deporte,plan_nations FROM public.torneos WHERE id=$1 FOR UPDATE', [tid])).rows[0];
    if (!torneo) throw bulkError('Torneo no encontrado', 404, 'TOURNAMENT_NOT_FOUND');
    const roles = (await client.query(
      'SELECT role,sede_id FROM public.user_roles WHERE user_id=$1 FOR SHARE', [auth.user.id])).rows;
    const currentRole = roles.length === 1 ? { rol: roles[0].role, sede_id: roles[0].sede_id } : null;
    if (!resolveTorneoAdminAccess({ role: currentRole }, torneo.sede_id).allowed) {
      throw bulkError('No tenés permiso para operar este torneo', 403, 'TOURNAMENT_SCOPE_CHANGED');
    }
    // Fail closed if deployment has not installed the preparation/activation
    // contract. In particular, the old dobles guard allowed Start without court.
    const readiness = (await client.query(`SELECT
      to_regprocedure('public.proteger_cancha_marcador_activo()') IS NOT NULL
      AND to_regprocedure('public.proteger_marcador_nations()') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.scoreboard_partidos'::regclass AND tgname='proteger_cancha_marcador_activo' AND NOT tgisinternal AND tgenabled='O')
      AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_scoreboard_bulk_active_match_v2') AND indisvalid AND indisunique)
      AS ready`)).rows[0];
    if (readiness?.ready !== true) throw bulkError('La preparación requiere actualizar el contrato de activación', 503, 'BULK_MIGRATION_REQUIRED');
    const partidos = (await client.query(
      'SELECT id,torneo_id,sede_id,cancha,fecha_hora,estado,equipo_a_id,equipo_b_id FROM public.partidos WHERE torneo_id=$1 ORDER BY id FOR UPDATE', [tid])).rows;
    const equipos = (await client.query(
      'SELECT id,nombre,jugadores FROM public.equipos WHERE torneo_id=$1 ORDER BY id FOR SHARE', [tid])).rows;
    const equiposMap = new Map(equipos.map(team => [Number(team.id), team]));
    const items = [];
    for (let index = 0; index < partidos.length; index += 1) {
      const partido = partidos[index];
      let equipoA = equiposMap.get(Number(partido.equipo_a_id));
      let equipoB = equiposMap.get(Number(partido.equipo_b_id));
      const canchaPrevista = resolveCanchaForPartidoIndex(partido, index, options);
      let scoreboard = null;
      await client.query('SAVEPOINT bulk_item');
      try {
        if (Number(partido.sede_id) !== Number(torneo.sede_id)) {
          throw bulkError('El partido requiere revisión de sede', 409, 'MATCH_SCOPE_MISMATCH');
        }
        const active = (await client.query(`SELECT ${SCOREBOARD_INSERT_SELECT}
          FROM public.scoreboard_partidos WHERE partido_torneo_id=$1
          AND lower(trim(coalesce(estado,''))) NOT IN ('terminado','finalizado') ORDER BY id FOR UPDATE`, [partido.id])).rows;
        if (active.length > 1 || active.some(row => Number(row.torneo_id) !== tid || Number(row.sede_id) !== Number(torneo.sede_id))) {
          throw bulkError('El marcador vinculado requiere revisión', 409, 'SCOREBOARD_SCOPE_OR_DUPLICATE');
        }
        scoreboard = active[0] ?? null;
        let status = scoreboard ? 'existing' : 'created';
        let skipReason;
        if (!equipoA || !equipoB || Number(equipoA.id) === Number(equipoB.id)) skipReason = 'missing_teams';
        else if (!isPartidoEstadoJugable(partido.estado)) skipReason = 'estado_no_jugable';
        else if (String(torneo.modalidad_plantel).toLowerCase() === 'selecciones') {
          try { equipoA = declaredRosterTeam(equipoA); equipoB = declaredRosterTeam(equipoB); }
          catch (error) { if (error.status && error.status < 500) skipReason = error.code || 'national_roster_incomplete'; else throw error; }
        }
        if (skipReason) {
          const visibleScoreboard = skipReason === 'missing_teams' ? null : scoreboard;
          items.push(bulkItem({ partido, scoreboard: visibleScoreboard, canchaPrevista, equipoA, equipoB, status: 'skipped', skip_reason: skipReason }));
          await client.query('RELEASE SAVEPOINT bulk_item');
          continue;
        }
        let token = null;
        if (!scoreboard) {
          const row = buildScoreboardInsertRow({ partido, torneo, equipoA, equipoB, cancha: null });
          if (options.emitir_tokens) {
            token = generateControlToken();
            row.control_token_hash = hashControlToken(token);
            row.control_token_created_at = new Date().toISOString();
          }
          const fields = Object.keys(row);
          const values = Object.values(row).map(value => value && typeof value === 'object' ? JSON.stringify(value) : value);
          // A legacy creator may race outside this transaction. DO NOTHING does
          // not change the winner's token, scores or clock. NULL-state legacy
          // rows are read above, even though the historical index excludes NULL.
          scoreboard = (await client.query(`INSERT INTO public.scoreboard_partidos (${fields.join(',')})
            VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})
            ON CONFLICT DO NOTHING RETURNING ${SCOREBOARD_INSERT_SELECT}`, values)).rows[0];
          if (!scoreboard) {
            const winners = (await client.query(`SELECT ${SCOREBOARD_INSERT_SELECT} FROM public.scoreboard_partidos
              WHERE partido_torneo_id=$1 AND lower(trim(coalesce(estado,''))) NOT IN ('terminado','finalizado') FOR UPDATE`, [partido.id])).rows;
            if (winners.length !== 1 || Number(winners[0].torneo_id) !== tid || Number(winners[0].sede_id) !== Number(torneo.sede_id)) {
              throw bulkError('No se confirmó el marcador concurrente', 409, 'SCOREBOARD_CONFLICT');
            }
            scoreboard = winners[0]; status = 'existing'; token = null;
          }
        } else if (options.reemitir_tokens && !['suspendido','suspendida','cancelado','cancelada'].includes(String(scoreboard.estado).toLowerCase())) {
          token = generateControlToken();
          const changed = await client.query(`UPDATE public.scoreboard_partidos SET control_token_hash=$2,
            control_token_created_at=now(),control_token_revoked_at=NULL,updated_at=now() WHERE id=$1 RETURNING id`,
          [scoreboard.id, hashControlToken(token)]);
          if (changed.rows.length !== 1) throw bulkError('No se confirmó la emisión del token', 503, 'TOKEN_UNCONFIRMED');
        }
        const item = bulkItem({ partido, scoreboard, canchaPrevista, equipoA, equipoB, status });
        if (torneo.plan_nations && item.requires_activation) {
          item.activation_path = `/api/torneos/${tid}/nations-cup/partidos/${partido.id}/marcador`;
        }
        item.control_token = token;
        if (status === 'existing' && !token) item.existing_note = 'scoreboard_already_exists';
        items.push(item);
        await client.query('RELEASE SAVEPOINT bulk_item');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT bulk_item');
        await client.query('RELEASE SAVEPOINT bulk_item');
        // Keep original links for a failed explicit reissue, but never return a
        // token generated by a rolled-back write or claim an uncommitted insert.
        const item = bulkItem({ partido, scoreboard: scoreboard?.id && options.reemitir_tokens ? scoreboard : null,
          canchaPrevista, equipoA, equipoB, status: 'failed' });
        item.error_code = error.code === '42501' ? 'SCOREBOARD_PERMISSION_DENIED' :
          error.code === '23505' ? 'SCOREBOARD_CONFLICT' : error.status ? error.code : 'SCOREBOARD_PREPARATION_FAILED';
        item.error = 'No se pudo preparar este marcador. Revisa el partido y vuelve a intentar.';
        items.push(item);
      }
    }
    await client.query('COMMIT');
    const count = status => items.filter(item => item.status === status).length;
    const empty = partidos.length === 0;
    return { ok: count('failed') === 0, partial: count('failed') > 0, torneo_id: tid,
      created: count('created'), existing: count('existing'), skipped: count('skipped'), failed: count('failed'), total: partidos.length, items,
      ...(empty ? { code: 'NO_ELIGIBLE_MATCHES', message: String(torneo.modalidad_plantel || '').toLowerCase() === 'selecciones' ? 'Los enlaces se generan cuando los grupos estén armados y los cruces definidos. No hay partidos concretos para preparar.' : 'No hay partidos concretos para preparar.' } : {}) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    if (error.status) throw error;
    throw bulkError('No se confirmó la preparación. Recarga antes de reintentar.', 503, 'BULK_UNCONFIRMED');
  } finally { client.release(); }
}
