import { randomUUID } from 'node:crypto';
import { sanitizePushData } from './mobilePushNotifications.js';
import { validateAdminPushSegment } from './adminPushNotifications.js';
import { isInternalApiSecretAuthorized } from './authAccess.js';

const TYPES = new Set(['reserva_confirmada','recordatorio_reserva','reserva_cancelada','reserva_modificada',
  'partido_solicitud','partido_solicitud_aceptada','partido_solicitud_rechazada','partido_completo',
  'invitacion_torneo_dupla','resultado_partido','torneo_inscripcion_confirmada','torneo_nuevo',
  'torneo_fixture','torneo_equipo_completo','ranking_actualizado','admin_message','general']);

// Legacy producer metadata is server generated. Unknown event names remain
// generic; never invent a confirmation/result merely to fit a new event name.
export function normalizeLegacyPushData(raw = {}) {
  const type = TYPES.has(raw.type) ? raw.type : 'general';
  let route = 'Notificaciones', params = {};
  const partidoId = raw.partidoId ?? raw.partido_id;
  const torneoId = raw.torneoId ?? raw.torneo_id;
  if (partidoId != null) { route = 'PartidoDetalle'; params = { partidoId }; }
  else if (torneoId != null) { route = 'TorneoDetalle'; params = { torneoId }; }
  else if (raw.reservaId != null || raw.reserva_id != null || raw.type === 'reserva') route = 'Reservas';
  if (raw.route) { route = raw.route; params = raw.params || {}; }
  try { return sanitizePushData({ type, route, params, notificationId: raw.notificationId, eventId: raw.eventId }); }
  catch { return { type, route: 'Notificaciones', params: {} }; }
}

export function createLegacyPushBridge({ supabaseAdmin, pushService, runtime }) {
  async function owners(tokens) {
    const requested = [...new Set((tokens || []).filter((token) => typeof token === 'string'))];
    if (!requested.length) return [];
    const result = [];
    for (let index=0;index<requested.length;index+=100) {
      const { data, error } = await supabaseAdmin.from('push_tokens')
        .select('id,user_id,expo_push_token').in('expo_push_token',requested.slice(index,index+100))
        .eq('enabled',true).is('revoked_at',null).is('invalidated_at',null);
      if (error) throw Object.assign(new Error('No se pudo comprobar el registro push'),{status:503});
      result.push(...(data || []));
    }
    return result;
  }
  async function send({ userIds, tokens, title, body, data = {}, category = 'transactional', idempotencyKey, source = 'legacy_system' }) {
    if (!runtime.pushSendEnabled) return { ok:false, skipped:true, disabled:true };
    const rows = tokens ? await owners(tokens) : null;
    const recipients = rows ? [...new Set(rows.map(row=>row.user_id))] : userIds;
    if (!recipients?.length) return {ok:false,skipped:true};
    const result = await pushService.dispatch({
      idempotencyKey: idempotencyKey || `${source}:${randomUUID()}`,
      userIds: recipients, tokenIds: rows?.map(row=>row.id), title, body, category,
      data: normalizeLegacyPushData(data), source,
    });
    return {ok:true,...result};
  }
  return { owners, send, async tokensForUser(userId) {
    return (await pushService.fetchEligibleTokens([userId],'transactional')).map(row=>row.token);
  } };
}

export function mountLegacyPushBridgeRoute(app,{ bridge,adminListScopeFromRequest,sedesPermitidasPorScope,supabaseAdmin }) {
  app.post('/api/push/send', async (req,res) => {
    try {
      const internal = isInternalApiSecretAuthorized(req);
      const scope = internal ? null : await adminListScopeFromRequest(req);
      if (!internal && !scope?.authUserId) return res.status(401).json({error:'No autorizado'});
      const {title,body,data} = req.body || {};
      const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens : req.body?.tokens ? [req.body.tokens] : [];
      if (!title || !body || !tokens.length) return res.status(400).json({error:'tokens, title y body son requeridos'});
      const rows = await bridge.owners(tokens);
      if (rows.length !== new Set(tokens).size) return res.status(403).json({error:'Sólo se admiten instalaciones activas registradas'});
      if (!internal) for (const userId of new Set(rows.map(row=>row.user_id))) {
        await validateAdminPushSegment(scope,{type:'jugador',userId},{supabase:supabaseAdmin,sedesPermitidasPorScopeFn:sedesPermitidasPorScope});
      }
      // This HTTP route accepts free text. It cannot claim to be an operational event.
      const result = await bridge.send({tokens,title,body,data,category:'marketing',
        idempotencyKey:req.body?.idempotencyKey ? `legacy_http:${internal ? 'internal' : scope.authUserId}:${String(req.body.idempotencyKey).slice(0,100)}` : undefined,source:'legacy_http'});
      return res.status(result.disabled ? 503 : 200).json(result);
    } catch(error) {return res.status(error.status || 503).json({error:error.message || 'No se pudo enviar push'});}
  });
}
