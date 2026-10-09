import { buildCrmEmailCapability } from '../lib/crmEmailSender.js';
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

  const emailCapability = buildCrmEmailCapability(env);
  const deliveryEnabled = truthy(env.OUTBOUND_DELIVERY_ENABLED);
  const whatsappConfigured = whatsappMissing.length === 0;
  return {
    outbound_delivery_enabled: deliveryEnabled,
    whatsapp: {
      configured: whatsappConfigured,
      enabled: deliveryEnabled && truthy(env.WHATSAPP_CLOUD_SEND_ENABLED) && whatsappConfigured,
      missing: whatsappMissing,
    },
    email: {
      ...emailCapability,
    },
    human_action_required: !deliveryEnabled || !whatsappConfigured || !emailCapability.configured,
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

  // Contrato consumido por el panel actual (identifica la fila por el email
  // mostrado en Validaciones). Es un cierre reversible de la solicitud: no
  // elimina el jugador ni modifica su nivel vigente.
  app.post('/api/admin/jugadores/validaciones/:email/rechazar', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const email = decodeURIComponent(String(req.params.email || '')).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Email inválido' });
      }
      const motivo = req.body?.motivo == null ? 'Rechazada por administración' : cleanReason(req.body.motivo);
      if (!motivo) return res.status(400).json({ error: 'El motivo debe tener entre 3 y 500 caracteres' });
      const { data, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .update({ pendiente_validacion: false })
        .eq('email', email)
        .eq('pendiente_validacion', true)
        .select('user_id, email, nivel, pendiente_validacion')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Validación pendiente no encontrada' });
      return res.json({ validacion: data, resultado: 'rechazada', motivo });
    } catch (error) {
      console.error('❌ POST /api/admin/jugadores/validaciones/:email/rechazar:', error.message);
      return res.status(500).json({ error: 'No se pudo rechazar la validación' });
    }
  });

  app.get('/api/admin/crm/channel-status', async (req, res) => {
    const auth = await requireSuperAdminUser(req, res, authDeps);
    if (!auth) return;
    return res.json(buildCrmChannelStatus(env));
  });
}
