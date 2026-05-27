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
