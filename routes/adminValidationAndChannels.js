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

  app.get('/api/admin/validaciones', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const rows = [];
      let lastId = null;
      while (true) {
        let query = supabaseAdmin.from('jugadores_perfil')
          .select('id, email, nombre, apellido, alias, user_id, pais, nivel, genero, categoria_validada')
          .eq('pendiente_validacion', true);
        if (lastId !== null) query = query.gt('id', lastId);
        const { data, error } = await query.order('id', { ascending: true }).limit(100);
        if (error) throw error;
        if (!Array.isArray(data)) throw new Error('Respuesta inválida de validaciones');
        if (!data.length) break;
        if (rows.length + data.length > 10000) return res.status(503).json({ error: 'Demasiadas validaciones; requiere paginación' });
        for (const row of data) {
          const raw = row.id;
          if ((typeof raw === 'number' && !Number.isSafeInteger(raw)) || !/^-?\d+$/.test(String(raw))) throw new Error('Identidad de perfil imprecisa');
          const id = BigInt(raw);
          if (lastId !== null && id <= BigInt(lastId)) throw new Error('Orden inválido de validaciones');
          lastId = id.toString();
        }
        rows.push(...data);
      }
      const pending = rows.filter((row) => row.categoria_validada !== true && row.categoria_validada !== 1 && !['true', '1'].includes(String(row.categoria_validada ?? '').trim().toLowerCase()));
      return res.json({ validaciones: pending });
    } catch (error) {
      console.error('❌ GET /api/admin/validaciones:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar las validaciones' });
    }
  });

  app.patch('/api/admin/validaciones/perfil/:id', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const id = String(req.params.id || '');
      if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) return res.status(400).json({ error: 'Perfil inválido' });
      const { accion, nivel, motivo } = req.body || {};
      if (!['aprobar', 'rechazar', 'categoria'].includes(accion)) return res.status(400).json({ error: 'Acción inválida' });
      if (accion === 'rechazar' && !cleanReason(motivo)) return res.status(400).json({ error: 'Motivo inválido' });
      if (accion === 'categoria' && !['Principiante','6ta','5ta','4ta','3ra','2da','1ra','Elite'].includes(nivel)) return res.status(400).json({ error: 'Categoría inválida' });
      const changes = { pendiente_validacion: false, ...(accion === 'categoria' ? { nivel } : {}) };
      const { data, error } = await supabaseAdmin.from('jugadores_perfil').update(changes)
        .eq('id', id).eq('pendiente_validacion', true).select('id').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: 'La solicitud ya cambió o no existe. Actualizá la lista.' });
      return res.json({ ok: true });
    } catch (error) {
      console.error('❌ PATCH /api/admin/validaciones/perfil:', error.message);
      return res.status(500).json({ error: 'No se pudo confirmar el cambio de validación' });
    }
  });

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
