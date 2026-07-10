const NOTIFICACIONES_TABLE = 'notificaciones';

export async function createNotificacion(supabaseAdmin, payload) {
  const userId = payload?.user_id;
  const tipo = String(payload?.tipo ?? '').trim();
  const mensaje = String(payload?.mensaje ?? '').trim();

  if (!userId || !tipo || !mensaje) return null;

  try {
    const { data, error } = await supabaseAdmin
      .from(NOTIFICACIONES_TABLE)
      .insert({
        user_id: userId,
        tipo,
        titulo: payload.titulo ?? null,
        mensaje,
        data: payload.data ?? {},
        leida: false,
      })
      .select('*')
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('⚠️ createNotificacion:', err.message);
    return null;
  }
}

export async function findNotificacionByDedupeKey(supabaseAdmin, userId, dedupeKey) {
  if (!userId || !dedupeKey) return null;

  try {
    const { data, error } = await supabaseAdmin
      .from(NOTIFICACIONES_TABLE)
      .select('id, user_id, tipo, data, created_at')
      .eq('user_id', userId)
      .contains('data', { dedupe_key: dedupeKey })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (isNotificacionesTableMissing(error)) return null;
      throw error;
    }

    return data ?? null;
  } catch (err) {
    console.warn('⚠️ findNotificacionByDedupeKey:', err.message);
    return null;
  }
}

export async function createNotificacionIfAbsent(supabaseAdmin, payload) {
  const dedupeKey = payload?.data?.dedupe_key ?? null;
  if (dedupeKey) {
    const existing = await findNotificacionByDedupeKey(
      supabaseAdmin,
      payload.user_id,
      dedupeKey,
    );
    if (existing) {
      return { created: false, duplicate: true, notificacion: existing };
    }
  }

  const notificacion = await createNotificacion(supabaseAdmin, payload);
  if (!notificacion) {
    return { created: false, duplicate: false, notificacion: null };
  }

  return { created: true, duplicate: false, notificacion };
}

export async function markNotificacionLeida(supabaseAdmin, notificacionId, userId) {
  const { data, error } = await supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .update({ leida: true })
    .eq('id', notificacionId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function markAllNotificacionesLeidas(supabaseAdmin, userId) {
  const { error } = await supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .update({ leida: true })
    .eq('user_id', userId)
    .eq('leida', false);

  if (error) throw error;
}

export function isNotificacionesTableMissing(error) {
  const msg = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || msg.includes('notificaciones')
  );
}
