import { requireAdminUser } from '../lib/authAccess.js';

function parseSedeId(value) {
  const id = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function canManage(auth, sedeId) {
  return auth?.role?.rol === 'super_admin'
    || (auth?.role?.rol === 'admin_club' && Number(auth.role.sede_id) === Number(sedeId));
}

export function mountStoreSedeConfigRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const authDeps = { getAuthenticatedUser, fetchUserRoleRowForAuthUser, legacySuperAdminEmails };

  app.get('/api/sedes/:id/tienda-config', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.id);
      if (!sedeId) return res.status(400).json({ error: 'sede_id inválido' });
      const [{ data: config, error: configError }, { data: paymentMethods, error: methodsError }] = await Promise.all([
        supabaseAdmin.from('store_sede_config').select('*').eq('sede_id', sedeId).maybeSingle(),
        supabaseAdmin.from('store_sede_payment_methods').select('id,codigo,nombre,activo,instrucciones').eq('sede_id', sedeId).eq('activo', true).order('nombre'),
      ]);
      if (configError) throw configError;
      if (methodsError) throw methodsError;
      return res.json({ config: config || { sede_id: sedeId, estado: 'opening_soon' }, payment_methods: paymentMethods || [] });
    } catch (error) {
      console.error('GET tienda-config:', error.message);
      return res.status(500).json({ error: 'No se pudo cargar la configuración de tienda' });
    }
  });

  app.put('/api/sedes/:id/tienda-config', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, authDeps);
      if (!auth) return;
      const sedeId = parseSedeId(req.params.id);
      if (!sedeId) return res.status(400).json({ error: 'sede_id inválido' });
      if (!canManage(auth, sedeId)) return res.status(403).json({ error: 'No tenés permiso para administrar esta tienda' });
      const body = req.body || {};
      const estado = ['active', 'opening_soon', 'paused'].includes(body.estado) ? body.estado : 'opening_soon';
      const config = {
        sede_id: sedeId, estado,
        retiro_en_sede: Boolean(body.retiro_en_sede),
        entrega_local: Boolean(body.entrega_local),
        radio_entrega_km: body.entrega_local && Number.isFinite(Number(body.radio_entrega_km)) ? Number(body.radio_entrega_km) : null,
        instrucciones_retiro: String(body.instrucciones_retiro || '').trim().slice(0, 1000) || null,
        instrucciones_entrega: String(body.instrucciones_entrega || '').trim().slice(0, 1000) || null,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await supabaseAdmin.from('store_sede_config').upsert(config, { onConflict: 'sede_id' }).select('*').single();
      if (error) throw error;
      return res.json({ config: data });
    } catch (error) {
      console.error('PUT tienda-config:', error.message);
      return res.status(500).json({ error: 'No se pudo guardar la configuración de tienda' });
    }
  });
}
