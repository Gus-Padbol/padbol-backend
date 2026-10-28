const ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function parseWatchAction(body = {}) {
  const actionId = String(body.action_id ?? '').trim();
  const deviceId = String(body.device_id ?? '').trim();
  const expectedRevision = Number(body.expected_revision);
  const command = String(body.command ?? body.type ?? '').trim().toLowerCase();
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : body;

  if (!ACTION_ID_RE.test(actionId)) throw badRequest('action_id inválido');
  if (!DEVICE_ID_RE.test(deviceId)) throw badRequest('device_id inválido');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw badRequest('expected_revision inválida');
  }
  if (!['punto', 'deshacer', 'saque', 'tiebreak', 'cronometro'].includes(command)) {
    throw badRequest('command inválido');
  }

  const action = { action_id: actionId, device_id: deviceId, expected_revision: expectedRevision, command };
  if (body.sent_at != null) {
    const sentAt = new Date(body.sent_at);
    if (!Number.isFinite(sentAt.getTime())) throw badRequest('sent_at inválido');
    action.sent_at = sentAt.toISOString();
  }
  if (command === 'punto') {
    const equipo = String(payload.equipo ?? '').trim().toUpperCase();
    if (!['A', 'B'].includes(equipo)) throw badRequest('equipo debe ser A o B');
    action.equipo = equipo;
  }
  if (command === 'cronometro') {
    const accion = String(payload.accion ?? '').trim().toLowerCase();
    if (!['start', 'pause', 'reset'].includes(accion)) throw badRequest('accion de cronómetro inválida');
    action.accion = accion;
  }
  return action;
}

export function assertWatchSessionActive(session, deviceId, now = new Date()) {
  if (!session || session.revoked_at) {
    throw Object.assign(new Error('Sesión de control revocada'), { status: 401 });
  }
  if (session.expires_at && new Date(session.expires_at).getTime() <= now.getTime()) {
    throw Object.assign(new Error('Sesión de control vencida'), { status: 401 });
  }
  if (String(session.device_id) !== String(deviceId)) {
    throw Object.assign(new Error('La sesión pertenece a otro dispositivo'), { status: 403 });
  }
}

export function toAtomicState(partido) {
  return {
    estado: partido.estado,
    saque_actual: partido.saque_actual,
    score_a: partido.score_a,
    score_b: partido.score_b,
    games_a: partido.games_a,
    games_b: partido.games_b,
    sets_a: partido.sets_a,
    sets_b: partido.sets_b,
    historial_sets: partido.historial_sets ?? [],
    es_tiebreak: Boolean(partido.es_tiebreak),
    ultimo_punto: partido.ultimo_punto ?? null,
    historial_puntos: partido.historial_puntos ?? [],
    cronometro_inicio: partido.cronometro_inicio ?? null,
    cronometro_pausado: Boolean(partido.cronometro_pausado),
    cronometro_segundos: Number(partido.cronometro_segundos) || 0,
  };
}

export function parseAtomicActionResult(data) {
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) throw new Error('La acción no devolvió resultado');
  if (result.status === 'conflict') {
    const err = Object.assign(new Error('El marcador cambió; sincronizá antes de reintentar'), {
      status: 409,
      current_revision: result.revision,
    });
    throw err;
  }
  return result;
}
