/** Roles admitidos en POST /api/admin/invite-magic-link */
export const MAGIC_INVITE_ROLES = new Set([
  'editor_contenido',
  'admin_cadena',
  'admin_club',
  'admin_nacional',
  'empleado',
]);

export function getInvitacionWebhookSecret() {
  return String(
    process.env.INVITATION_WEBHOOK_SECRET ||
      process.env.MERCADOPAGO_WEBHOOK_SECRET ||
      process.env.MP_WEBHOOK_SECRET ||
      '',
  ).trim();
}

export function assertInvitacionWebhookSecret(req) {
  const secret = getInvitacionWebhookSecret();
  if (!secret) {
    const e = new Error('INVITATION_WEBHOOK_SECRET (o MERCADOPAGO_WEBHOOK_SECRET) no configurado');
    e.status = 503;
    throw e;
  }
  const hdr = String(req.headers['x-webhook-secret'] || req.headers['X-Webhook-Secret'] || '').trim();
  if (hdr !== secret) {
    const e = new Error('Webhook no autorizado');
    e.status = 401;
    throw e;
  }
}

/** Normaliza payload de Make o Database Webhook (Supabase INSERT). */
export function parseInvitacionAdminWebhookBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const record = b.record || b.new || b.data?.record || b;
  const email = String(record?.email || b.email || '').trim().toLowerCase();
  const rol = String(record?.invited_role || record?.rol || b.rol || b.role || 'admin_club')
    .trim()
    .toLowerCase();
  const nombre =
    String(record?.nombre_club || record?.nombre || b.nombre || b.nombre_club || '').trim() || null;
  const sedeRaw = record?.sede_id ?? b.sede_id;
  const sede_id =
    sedeRaw != null && String(sedeRaw).trim() !== '' && Number.isFinite(Number(sedeRaw))
      ? Number(sedeRaw)
      : null;
  return {
    email,
    rol,
    nombre,
    sede_id,
    invitacion_id: record?.id || b.invitacion_id || null,
  };
}

export function createGenerateAdminInviteMagicLink({ supabase, getFrontendUrl }) {
  async function upsertRoleForMagicInvite({ email, rol, nombre, sede_id }) {
    const role = String(rol || '').trim().toLowerCase();
    if (role === 'editor_contenido') {
      const payload = {
        email,
        role: 'editor_contenido',
        alcance: 'global',
        sede_id: null,
        ciudad: null,
        provincia: null,
        pais: null,
        nombre: nombre || null,
        torneos_oficiales_habilitados: false,
      };
      const { data: existing } = await supabase.from('user_roles').select('email').eq('email', email).maybeSingle();
      if (existing?.email) {
        const { error } = await supabase.from('user_roles').update(payload).eq('email', email);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('user_roles').insert(payload);
        if (error) throw error;
      }
      return;
    }
    if (role === 'empleado' && sede_id != null) {
      const { data: sedeRow, error: sedeErr } = await supabase
        .from('sedes')
        .select('id, nombre, ciudad, provincia, pais')
        .eq('id', sede_id)
        .maybeSingle();
      if (sedeErr) throw sedeErr;
      if (!sedeRow?.id) {
        const e = new Error('sede_id no encontrada');
        e.status = 400;
        throw e;
      }
      const payload = {
        email,
        role: 'empleado',
        alcance: 'sede',
        sede_id: sedeRow.id,
        ciudad: sedeRow.ciudad || null,
        provincia: sedeRow.provincia || null,
        pais: sedeRow.pais || null,
        nombre: nombre || null,
        torneos_oficiales_habilitados: false,
      };
      const { data: existing } = await supabase.from('user_roles').select('email').eq('email', email).maybeSingle();
      if (existing?.email) {
        const { error } = await supabase.from('user_roles').update(payload).eq('email', email);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('user_roles').insert(payload);
        if (error) throw error;
      }
    }
  }

  return async function generateAdminInviteMagicLink({ email, rol, nombre, sede_id, assignRole }) {
    const em = String(email || '').trim().toLowerCase();
    const role = String(rol || '').trim().toLowerCase();
    const name = String(nombre || '').trim() || null;

    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      const e = new Error('Email inválido');
      e.status = 400;
      throw e;
    }
    if (!MAGIC_INVITE_ROLES.has(role)) {
      const e = new Error('Rol inválido');
      e.status = 400;
      throw e;
    }
    if (role === 'empleado' && assignRole && (sede_id == null || !Number.isFinite(Number(sede_id)))) {
      const e = new Error('sede_id obligatorio para empleado');
      e.status = 400;
      throw e;
    }

    const shouldAssign =
      assignRole === true || role === 'editor_contenido' || (role === 'empleado' && sede_id != null);
    if (shouldAssign) {
      await upsertRoleForMagicInvite({ email: em, rol: role, nombre: name, sede_id });
    }

    const base = String(getFrontendUrl() || '').replace(/\/$/, '');
    const redirectTo = `${base}/auth`;

    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: em,
      options: { redirectTo },
    });
    if (error) throw error;

    const magic_link =
      data?.properties?.action_link || data?.action_link || data?.link || null;
    if (!magic_link) {
      const e = new Error('No se pudo generar el magic link');
      e.status = 500;
      throw e;
    }

    return { magic_link, email: em, nombre: name, rol: role };
  };
}
