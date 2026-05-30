const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function sendExpoPushMessages(messages) {
  const valid = (messages ?? []).filter(
    (message) => message?.to && String(message.to).startsWith('ExponentPushToken['),
  );
  if (!valid.length) return { ok: true, skipped: true };

  const chunks = [];
  for (let i = 0; i < valid.length; i += 100) {
    chunks.push(valid.slice(i, i + 100));
  }

  const results = [];
  for (const chunk of chunks) {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(chunk),
      });
      const json = await response.json().catch(() => ({}));
      results.push(json);
    } catch (error) {
      console.error('Push notification error:', error);
      results.push({ error: error?.message ?? String(error) });
    }
  }

  return { ok: true, results };
}

export async function sendPushToTokens(tokens, title, body, data = {}) {
  const unique = [...new Set((tokens ?? []).filter(Boolean))];
  if (!unique.length) return { ok: true, skipped: true };

  const messages = unique.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    data,
    color: '#e33030',
  }));

  return sendExpoPushMessages(messages);
}

export async function resolveUserPushTokens(supabaseAdmin, userId) {
  if (!userId) return [];

  const tokens = new Set();

  const { data: rows, error } = await supabaseAdmin
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);

  if (!error) {
    (rows ?? []).forEach((row) => {
      if (row?.token) tokens.add(row.token);
    });
  }

  const { data: perfil } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('push_token, expo_push_token')
    .eq('user_id', userId)
    .maybeSingle();

  const legacy = perfil?.push_token ?? perfil?.expo_push_token ?? null;
  if (legacy) tokens.add(legacy);

  return [...tokens];
}

export async function sendPushToUser(supabaseAdmin, userId, { title, body, data = {} }) {
  const tokens = await resolveUserPushTokens(supabaseAdmin, userId);
  if (!tokens.length) {
    console.log('[push]', userId, title, '(sin token)');
    return { ok: false, skipped: true };
  }

  return sendPushToTokens(tokens, title, body, data);
}

export async function sendPushToUsers(supabaseAdmin, userIds, payload) {
  const uniqueIds = [...new Set((userIds ?? []).filter(Boolean))];
  const tokenSet = new Set();

  await Promise.all(
    uniqueIds.map(async (userId) => {
      const tokens = await resolveUserPushTokens(supabaseAdmin, userId);
      tokens.forEach((token) => tokenSet.add(token));
    }),
  );

  return sendPushToTokens([...tokenSet], payload.title, payload.body, payload.data ?? {});
}

/** @deprecated */
export async function sendPushNotification(pushToken, title, body, data = {}) {
  return sendPushToTokens([pushToken], title, body, data);
}

/** @deprecated */
export async function resolveUserPushToken(supabaseAdmin, userId) {
  const tokens = await resolveUserPushTokens(supabaseAdmin, userId);
  return tokens[0] ?? null;
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
