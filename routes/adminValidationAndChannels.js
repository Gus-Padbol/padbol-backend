import { requireSuperAdminUser } from '../lib/authAccess.js';

const truthy = (value) => String(value || '').trim().toLowerCase() === 'true';
const present = (value) => String(value || '').trim().length > 0;

export function buildCrmChannelStatus(env = {}) {
  const whatsappMissing = [
    'WHATSAPP_META_GRAPH_VERSION',
    'WHATSAPP_META_APP_SECRET',
    'WHATSAPP_META_VERIFY_TOKEN',
  ].filter((key) => !present(env[key]));
  const whatsappTokenReady = present(env.WHATSAPP_META_ACCESS_TOKEN)
    || present(env.WHATSAPP_META_TOKEN_TEST);
  if (!whatsappTokenReady) whatsappMissing.push('WHATSAPP_META_ACCESS_TOKEN');

  const emailProvider = present(env.CRM_OUTBOUND_EMAIL_PROVIDER)
    ? String(env.CRM_OUTBOUND_EMAIL_PROVIDER).trim().toLowerCase()
    : null;
  const emailMissing = [];
  if (!emailProvider) emailMissing.push('CRM_OUTBOUND_EMAIL_PROVIDER');
  if (!present(env.CRM_OUTBOUND_EMAIL_FROM)) emailMissing.push('CRM_OUTBOUND_EMAIL_FROM');
  if (!present(env.CRM_OUTBOUND_EMAIL_API_KEY) && !present(env.SMTP_URL)) {
    emailMissing.push('CRM_OUTBOUND_EMAIL_API_KEY_OR_SMTP_URL');
  }

  const deliveryEnabled = truthy(env.OUTBOUND_DELIVERY_ENABLED);
  const whatsappConfigured = whatsappMissing.length === 0;
  const emailConfigured = emailMissing.length === 0;
  return {
    outbound_delivery_enabled: deliveryEnabled,
    whatsapp: {
      configured: whatsappConfigured,
      enabled: deliveryEnabled && truthy(env.WHATSAPP_CLOUD_SEND_ENABLED) && whatsappConfigured,
      missing: whatsappMissing,
    },
    email: {
      configured: emailConfigured,
      enabled: deliveryEnabled && truthy(env.CRM_OUTBOUND_EMAIL_ENABLED) && emailConfigured,
      provider: emailProvider,
      missing: emailMissing,
    },
    human_action_required: !deliveryEnabled || !whatsappConfigured || !emailConfigured,
  };
}

function cleanReason(value) {
  const reason = String(value || '').trim();
  if (reason.length < 3 || reason.length > 500) return null;
  return reason;
}

export function mountAdminValidationAndChannelsRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
  env = process.env,
}) {
  const authDeps = { getAuthenticatedUser, fetchUserRoleRowForAuthUser, legacySuperAdminEmails };

  app.patch('/api/admin/validaciones/:userId/rechazar', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const userId = String(req.params.userId || '').trim();
      const motivo = cleanReason(req.body?.motivo);
      if (!userId) return res.status(400).json({ error: 'userId requerido' });
      if (!motivo) return res.status(400).json({ error: 'El motivo debe tener entre 3 y 500 caracteres' });

      // Rechazar una validación no borra el perfil ni cambia su categoría. Sólo
      // cierra la solicitud pendiente; el motivo se devuelve para auditoría/UI.
      const { data, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .update({ pendiente_validacion: false })
        .eq('user_id', userId)
        .eq('pendiente_validacion', true)
        .select('user_id, email, nivel, pendiente_validacion')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Validación pendiente no encontrada' });
      return res.json({ validacion: data, resultado: 'rechazada', motivo });
    } catch (error) {
      console.error('❌ PATCH /api/admin/validaciones/:userId/rechazar:', error.message);
      return res.status(500).json({ error: 'No se pudo rechazar la validación' });
    }
  });

  app.get('/api/admin/crm/channel-status', async (req, res) => {
    const auth = await requireSuperAdminUser(req, res, authDeps);
    if (!auth) return;
    return res.json(buildCrmChannelStatus(env));
  });
}
