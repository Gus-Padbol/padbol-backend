import { requireSuperAdminUser } from '../lib/authAccess.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_STATES = new Set(['pendiente', 'aprobada', 'rechazada']);

function text(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

export function buildLicenseRequestPayload(body = {}) {
  const email = text(body.email, 254).toLowerCase();
  const clubNombre = text(body.club_nombre, 160);
  const responsableNombre = text(body.responsable_nombre, 160);
  const pais = text(body.pais, 100);
  const ciudad = text(body.ciudad, 120);
  if (!EMAIL_RE.test(email)) return { error: 'Ingresá un email de contacto válido' };
  if (!clubNombre) return { error: 'El nombre del club es obligatorio' };
  if (!responsableNombre) return { error: 'El nombre de la persona responsable es obligatorio' };
  // La solicitud pública es solamente el inicio comercial. La ubicación y
  // los datos operativos se completan después, desde la configuración guiada
  // de la sede, una vez que el acceso y el plan estén definidos.

  return {
    data: {
      club_nombre: clubNombre,
      club_direccion: text(body.club_direccion, 240) || null,
      // La tabla histórica todavía exige estos campos. Conservamos una marca
      // explícita hasta que la sede los complete en el asistente guiado.
      pais: pais || 'Pendiente de completar',
      ciudad: ciudad || 'Pendiente de completar',
      provincia_estado: text(body.provincia_estado, 120) || null,
      club_telefono: text(body.club_telefono, 80) || null,
      club_email: text(body.club_email, 254).toLowerCase() || null,
      club_web: text(body.club_web, 300) || null,
      deportes_canchas: body.deportes_canchas && typeof body.deportes_canchas === 'object'
        ? body.deportes_canchas
        : {},
      responsable_nombre: responsableNombre,
      responsable_cargo: text(body.responsable_cargo, 120) || null,
      email,
      whatsapp: text(body.whatsapp, 80) || null,
      nombre_legal: text(body.nombre_legal, 200) || null,
      numero_fiscal: text(body.numero_fiscal, 100) || null,
      fiscal_misma_que_club: body.fiscal_misma_que_club !== false,
      direccion_fiscal: text(body.direccion_fiscal, 240) || null,
      pais_fiscal: text(body.pais_fiscal, 100) || null,
      mensaje: text(body.mensaje, 2000) || null,
      estado: 'pendiente',
      tipo_interes: 'pendiente_definicion',
    },
  };
}

function isMissingTable(error) {
  return error?.code === '42P01' || /solicitudes_licencia/i.test(String(error?.message || ''));
}

function sendStorageError(res, error, fallback) {
  if (isMissingTable(error)) {
    return res.status(503).json({
      error: 'El formulario todavía no está habilitado en el servidor',
      code: 'LICENSE_REQUESTS_NOT_CONFIGURED',
    });
  }
  return res.status(500).json({ error: fallback });
}

export function mountLicenseRequestRoutes(app, {
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

  app.post('/api/solicitudes-licencia', async (req, res) => {
    try {
      const parsed = buildLicenseRequestPayload(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const { data, error } = await supabaseAdmin
        .from('solicitudes_licencia')
        .insert(parsed.data)
        .select('id, estado, created_at')
        .single();
      if (error) return sendStorageError(res, error, 'No se pudo enviar la solicitud');
      return res.status(201).json(data);
    } catch (error) {
      console.error('❌ POST /api/solicitudes-licencia:', error.message);
      return res.status(500).json({ error: 'No se pudo enviar la solicitud' });
    }
  });

  app.get('/api/admin/solicitudes-licencia', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const requestedState = text(req.query.estado, 20).toLowerCase();
      let query = supabaseAdmin.from('solicitudes_licencia').select('*').order('created_at', { ascending: false });
      if (ALLOWED_STATES.has(requestedState)) query = query.eq('estado', requestedState);
      const { data, error } = await query;
      if (error) return sendStorageError(res, error, 'No se pudieron cargar las solicitudes');
      return res.json(data || []);
    } catch (error) {
      console.error('❌ GET /api/admin/solicitudes-licencia:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar las solicitudes' });
    }
  });

  app.post('/api/admin/solicitudes-licencia/:id/rechazar', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const { data, error } = await supabaseAdmin
        .from('solicitudes_licencia')
        .update({ estado: 'rechazada', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('*')
        .maybeSingle();
      if (error) return sendStorageError(res, error, 'No se pudo rechazar la solicitud');
      if (!data) return res.status(404).json({ error: 'Solicitud no encontrada' });
      return res.json(data);
    } catch (error) {
      console.error('❌ POST rechazo solicitud licencia:', error.message);
      return res.status(500).json({ error: 'No se pudo rechazar la solicitud' });
    }
  });

  app.post('/api/admin/solicitudes-licencia/:id/tipo-interes', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, adminDeps);
      if (!auth) return;
      const tipoInteres = text(req.body?.tipo_interes, 120);
      if (!tipoInteres) return res.status(400).json({ error: 'tipo_interes es obligatorio' });
      const { data, error } = await supabaseAdmin
        .from('solicitudes_licencia')
        .update({ tipo_interes: tipoInteres, estado: 'aprobada', updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('*')
        .maybeSingle();
      if (error) return sendStorageError(res, error, 'No se pudo aprobar la solicitud');
      if (!data) return res.status(404).json({ error: 'Solicitud no encontrada' });
      return res.json(data);
    } catch (error) {
      console.error('❌ POST tipo interés solicitud licencia:', error.message);
      return res.status(500).json({ error: 'No se pudo aprobar la solicitud' });
    }
  });
}
