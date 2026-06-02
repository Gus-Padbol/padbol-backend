import { XP_VALORES } from './xpConfig.js';

export async function sumarXP(supabaseAdmin, userId, tipo, descripcion, referenciaId = null) {
  const xp = XP_VALORES[tipo];
  if (xp == null) {
    throw new Error(`Tipo de XP desconocido: ${tipo}`);
  }

  const { data, error } = await supabaseAdmin.rpc('sumar_xp', {
    p_user_id: userId,
    p_tipo: tipo,
    p_xp: xp,
    p_descripcion: descripcion ?? null,
    p_referencia_id: referenciaId != null ? String(referenciaId) : null,
  });

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    xp_sumado: row?.xp_sumado ?? xp,
    xp_total: row?.xp_total ?? null,
    liga: row?.liga ?? null,
  };
}

export async function getXPJugador(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('xp, liga')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  return {
    xp: data?.xp ?? 0,
    liga: data?.liga ?? 'INIT',
  };
}

export async function getHistorialXP(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('xp_transacciones')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return data ?? [];
}
