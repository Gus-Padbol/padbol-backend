import { applyHistorialPuntoSnapshot, registrarPunto } from '../../utils/scoreboardLogic.js';

export const TERMINAL_POINT_SELECT = 'id,partido_id,equipo,score_a_antes,score_b_antes,set_numero,games_a_antes,games_b_antes,sets_a_antes,sets_b_antes,es_tiebreak_antes,estado_antes,historial_sets_antes,saque_actual_antes,timestamp';

/** Evidence of the deciding recorded point, not a claim that every point was live. */
export function isTerminalScoreboardPoint(scoreboard, point) {
  if (!scoreboard || !point || String(point.partido_id) !== String(scoreboard.id)
    || !['A', 'B'].includes(point.equipo) || point.estado_antes !== 'en_curso'
    || !['terminado', 'finalizado'].includes(scoreboard.estado)
    || !Array.isArray(point.historial_sets_antes) || !Array.isArray(scoreboard.historial_sets)
    || !Number.isFinite(Date.parse(point.timestamp))
    || Date.parse(point.timestamp) > Date.parse(scoreboard.synced_to_torneo_at)
    || !Number.isFinite(Date.parse(scoreboard.synced_to_torneo_at))) return false;
  for (const key of ['games_a_antes', 'games_b_antes', 'sets_a_antes', 'sets_b_antes']) {
    if (!Number.isInteger(point[key]) || point[key] < 0) return false;
  }
  if (point.sets_a_antes >= 2 || point.sets_b_antes >= 2) return false;
  try {
    const replay = applyHistorialPuntoSnapshot(structuredClone(scoreboard), point);
    registrarPunto(replay, point.equipo);
    return replay.estado === 'terminado'
      && replay.sets_a === scoreboard.sets_a && replay.sets_b === scoreboard.sets_b
      && JSON.stringify(replay.historial_sets) === JSON.stringify(scoreboard.historial_sets);
  } catch { return false; }
}
