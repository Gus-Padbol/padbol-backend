const ROLE_COLUMNS = 'user_id,email,role,alcance,sede_id,organizacion_id,pais,provincia,ciudad,nombre,torneos_oficiales_habilitados';

function unavailable() {
  return Object.assign(new Error('No se pudo comprobar la identidad del rol'), { status: 503 });
}

// A pending assignment is claimed only by its authenticated, confirmed email
// owner. The compare-and-set cannot replace a role linked to another UUID.
export async function resolveStoredRoleForVerifiedUser(supabaseAdmin, user) {
  if (!user?.id) return null;
  const byId = await supabaseAdmin.from('user_roles').select(ROLE_COLUMNS)
    .eq('user_id', user.id).maybeSingle();
  if (byId.error) throw unavailable();
  if (byId.data) return byId.data;
  if (!user.email_confirmed_at) return null;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return null;
  const pending = await supabaseAdmin.from('user_roles').select(ROLE_COLUMNS)
    .eq('email', email).is('user_id', null).maybeSingle();
  if (pending.error) throw unavailable();
  if (!pending.data) return null;
  const claimed = await supabaseAdmin.from('user_roles').update({ user_id: user.id })
    .eq('email', email).is('user_id', null).select(ROLE_COLUMNS).maybeSingle();
  if (claimed.error) throw unavailable();
  if (claimed.data) return claimed.data;
  const raced = await supabaseAdmin.from('user_roles').select(ROLE_COLUMNS)
    .eq('user_id', user.id).maybeSingle();
  if (raced.error) throw unavailable();
  return raced.data || null;
}
