let mobilePushBridge = null;
export function configureMobilePushBridge(bridge) { mobilePushBridge = bridge; }
const unavailable = () => ({ ok:false, skipped:true, reason:'secure_delivery_not_configured' });
export async function sendExpoPushMessages(messages) {
  if (!mobilePushBridge) return unavailable();
  const results=[];
  for (const message of messages || []) results.push(await mobilePushBridge.send({ tokens:[message.to], title:message.title, body:message.body, data:message.data || {} }));
  return {ok:true,results};
}
export async function sendPushToTokens(tokens,title,body,data={}) {
  return mobilePushBridge ? mobilePushBridge.send({tokens,title,body,data}) : unavailable();
}
export async function resolveUserPushTokens(_supabaseAdmin,userId) {
  return mobilePushBridge && userId ? mobilePushBridge.tokensForUser(userId) : [];
}
export async function sendPushToUser(_supabaseAdmin,userId,payload) {
  return mobilePushBridge ? mobilePushBridge.send({userIds:[userId],...payload}) : unavailable();
}
export async function sendPushToUsers(_supabaseAdmin,userIds,payload) {
  return mobilePushBridge ? mobilePushBridge.send({userIds:[...new Set(userIds || [])],...payload}) : unavailable();
}
export async function sendPushNotification(token,title,body,data={}) {
  return sendPushToTokens([token],title,body,data);
}
export async function resolveUserPushToken(supabaseAdmin,userId) {
  return (await resolveUserPushTokens(supabaseAdmin,userId))[0] || null;
}

export async function collectEquipoUserIds(supabaseAdmin, equipoId) {
  const userIds = new Set();

  const { data: equipo } = await supabaseAdmin
    .from('equipos')
    .select('id, capitan_user_id')
    .eq('id', equipoId)
    .maybeSingle();

  if (equipo?.capitan_user_id) userIds.add(equipo.capitan_user_id);

  const { data: members } = await supabaseAdmin
    .from('equipos_jugadores')
    .select('user_id, estado')
    .eq('equipo_id', equipoId);

  (members ?? []).forEach((member) => {
    if (member?.user_id && (member.estado === 'aceptado' || member.estado == null)) {
      userIds.add(member.user_id);
    }
  });

  return [...userIds];
}

export async function notifyReservaConfirmada(supabaseAdmin, reserva) {
  if (!reserva?.user_id) return;
  const sede = reserva.sede ?? 'tu sede';
  const fecha = reserva.fecha ?? '';
  const hora = String(reserva.hora ?? '').slice(0, 5);

  await sendPushToUser(supabaseAdmin, reserva.user_id, {
    title: 'Reserva confirmada',
    body: `${sede} · ${fecha} ${hora}`.trim(),
    data: {
      type: 'reserva',
      reserva_id: String(reserva.id),
      reservaId: String(reserva.id),
    },
  });
}

export async function notifyPartidoJugadorUnido(supabaseAdmin, partido, jugadorNombre) {
  const capitanUserId = partido?.capitan_user_id ?? partido?.host_user_id ?? null;
  if (!capitanUserId) return;

  await sendPushToUser(supabaseAdmin, capitanUserId, {
    title: 'Nuevo jugador en tu partido',
    body: `${jugadorNombre ?? 'Un jugador'} se unió a tu partido`,
    data: {
      type: 'partido',
      partido_id: String(partido.id),
      partidoId: String(partido.id),
    },
  });
}

export async function notifyTorneoInscripcionConfirmada(supabaseAdmin, equipoId, torneoId) {
  const [{ data: torneo }, userIds] = await Promise.all([
    supabaseAdmin.from('torneos').select('id, nombre').eq('id', torneoId).maybeSingle(),
    collectEquipoUserIds(supabaseAdmin, equipoId),
  ]);

  const nombreTorneo = torneo?.nombre ?? 'el torneo';

  await sendPushToUsers(supabaseAdmin, userIds, {
    title: 'Inscripción confirmada',
    body: `Tu equipo quedó inscripto en ${nombreTorneo}`,
    data: {
      type: 'torneo',
      torneo_id: String(torneoId),
      torneoId: String(torneoId),
    },
  });
}

export async function notifyTorneoSorteoPublicado(supabaseAdmin, torneoId) {
  const { data: torneo } = await supabaseAdmin
    .from('torneos')
    .select('id, nombre')
    .eq('id', torneoId)
    .maybeSingle();

  const { data: equipos } = await supabaseAdmin
    .from('equipos')
    .select('id')
    .eq('torneo_id', torneoId);

  const userIds = new Set();
  await Promise.all(
    (equipos ?? []).map(async (equipo) => {
      const ids = await collectEquipoUserIds(supabaseAdmin, equipo.id);
      ids.forEach((id) => userIds.add(id));
    }),
  );

  await sendPushToUsers(supabaseAdmin, [...userIds], {
    title: 'Sorteo publicado',
    body: `Ya está el fixture de ${torneo?.nombre ?? 'tu torneo'}`,
    data: {
      type: 'torneo',
      torneo_id: String(torneoId),
      torneoId: String(torneoId),
    },
  });
}
