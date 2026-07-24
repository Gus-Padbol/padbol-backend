import { requireAdminUser, requireSuperAdminUser } from '../lib/authAccess.js';

const SENSITIVE_SEDE_KEYS = new Set([
  'mp_access_token',
  'mp_public_key',
  'stripe_secret_key',
  'stripe_webhook_secret',
  'password',
  'secret',
]);

export function sanitizeAdminSede(row) {
  if (!row || typeof row !== 'object') return null;
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !SENSITIVE_SEDE_KEYS.has(String(key).toLowerCase())),
  );
}

export function mapAdminRoleRow(row, sedesById = new Map()) {
  const sedeIdRaw = row?.sede_id;
  const sedeId = sedeIdRaw != null && sedeIdRaw !== '' && Number.isFinite(Number(sedeIdRaw))
    ? Number(sedeIdRaw)
    : null;
  const role = String(row?.role || row?.rol || '').trim().toLowerCase();
  let alcance = String(row?.alcance || '').trim().toLowerCase();
  if (!alcance) {
    if (role === 'super_admin') alcance = 'global';
    else if (role === 'admin_club') alcance = 'sede';
    else if (role === 'admin_nacional') alcance = 'pais';
    else if (role === 'editor_contenido') alcance = 'contenido';
  }
  return {
    user_id: row?.user_id || null,
    email: String(row?.email || '').trim().toLowerCase(),
    nombre: row?.nombre || null,
    role,
    rol: role,
    alcance: alcance || null,
    sede_id: sedeId,
    sede_nombre: sedeId != null ? sedesById.get(sedeId) || null : null,
    pais: row?.pais || null,
    provincia: row?.provincia || null,
    ciudad: row?.ciudad || null,
  };
}

async function safeCount(queryFactory) {
  try {
    const result = await queryFactory();
    if (result?.error) return 0;
    if (Number.isFinite(Number(result?.count))) return Number(result.count);
    return Array.isArray(result?.data) ? result.data.length : 0;
  } catch {
    return 0;
  }
}

export function mountAdminCoreRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const adminDeps = {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  };

  app.get('/api/sedes/todas', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const { data, error } = await supabaseAdmin.from('sedes').select('*').order('nombre');
      if (error) throw error;
      return res.json((data || []).map(sanitizeAdminSede).filter(Boolean));
    } catch (error) {
      console.error('❌ GET /api/sedes/todas:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar las sedes' });
    }
  });

  app.get('/api/admin/sedes-alcance', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      let query = supabaseAdmin.from('sedes').select('*').order('nombre');
      if (auth.role.rol === 'admin_club') query = query.eq('id', auth.role.sede_id);
      const { data, error } = await query;
      if (error) throw error;
      return res.json({
        rol: auth.role.rol,
        alcance: auth.role.rol === 'super_admin' ? 'global' : 'sede',
        sede_id: auth.role.sede_id,
        sedes: (data || []).map(sanitizeAdminSede).filter(Boolean),
      });
    } catch (error) {
      console.error('❌ GET /api/admin/sedes-alcance:', error.message);
      return res.status(500).json({ error: 'No se pudo resolver el alcance de sedes' });
    }
  });

  app.get('/api/admin/roles', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const [{ data: roles, error: rolesError }, { data: sedes, error: sedesError }] = await Promise.all([
        supabaseAdmin.from('user_roles').select('*').order('email'),
        supabaseAdmin.from('sedes').select('id, nombre'),
      ]);
      if (rolesError) throw rolesError;
      if (sedesError) throw sedesError;
      const sedesById = new Map((sedes || []).map((row) => [Number(row.id), row.nombre]));
      return res.json((roles || []).map((row) => mapAdminRoleRow(row, sedesById)));
    } catch (error) {
      console.error('❌ GET /api/admin/roles:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar los roles administrativos' });
    }
  });

  app.get('/api/admin/alertas-campanita', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, adminDeps);
      if (!auth) return;
      const sedeId = auth.role.rol === 'admin_club' ? auth.role.sede_id : null;
      const withSedeScope = (query) => (sedeId != null ? query.eq('sede_id', sedeId) : query);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const [instructoresPendientes, sedesPendientes, pagosFallidos, cancelaciones24h] = await Promise.all([
        safeCount(() => withSedeScope(
          supabaseAdmin.from('profesores').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),
        )),
        auth.role.rol === 'super_admin'
          ? safeCount(() => supabaseAdmin.from('sedes_pendientes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'))
          : 0,
        safeCount(() => withSedeScope(
          supabaseAdmin.from('reservas').select('id', { count: 'exact', head: true }).eq('pago_estado', 'fallido'),
        )),
        safeCount(() => withSedeScope(
          supabaseAdmin
            .from('reservas')
            .select('id', { count: 'exact', head: true })
            .eq('estado', 'cancelada')
            .gte('updated_at', since),
        )),
      ]);

      return res.json({
        rol: auth.role.rol,
        sede_id: sedeId,
        instructores_pendientes: instructoresPendientes,
        sedes_pendientes: sedesPendientes,
        pagos_fallidos: pagosFallidos,
        cancelaciones_24h: cancelaciones24h,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error('❌ GET /api/admin/alertas-campanita:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar las alertas administrativas' });
    }
  });
}
