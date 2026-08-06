import { requireSuperAdminUser } from '../lib/authAccess.js';

const PROFESOR_ADMIN_SELECT = [
  'id',
  'sede_id',
  'nombre',
  'apellido',
  'foto_url',
  'bio',
  'whatsapp',
  'deportes',
  'certificado_fipa',
  'aprobado',
  'activo',
  'created_at',
  'updated_at',
].join(', ');

function toProfesorDto(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    ...row,
    deportes: Array.isArray(row.deportes) ? row.deportes : [],
    aprobado: row.aprobado === true,
    activo: row.activo !== false,
  };
}

function profesorIdFromRequest(req) {
  const id = Number(req.params?.profesorId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function allowedProfessorUpdates(body) {
  const source = body && typeof body === 'object' ? body : {};
  const updates = {};

  if (source.sede_id != null && Number.isInteger(Number(source.sede_id))) {
    updates.sede_id = Number(source.sede_id);
  }
  if (Array.isArray(source.deportes)) {
    updates.deportes = source.deportes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  }
  for (const key of ['certificado_fipa', 'whatsapp', 'bio', 'fecha_nacimiento', 'genero']) {
    if (Object.prototype.hasOwnProperty.call(source, key)) updates[key] = source[key] ?? null;
  }
  return updates;
}

export function mountAdminProfesoresRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const authDeps = { getAuthenticatedUser, fetchUserRoleRowForAuthUser, legacySuperAdminEmails };

  app.get('/api/admin/profesores-todos', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const estado = String(req.query?.estado || 'todos').trim().toLowerCase();
      let query = supabaseAdmin.from('profesores').select(PROFESOR_ADMIN_SELECT);
      if (estado === 'pendiente') query = query.eq('aprobado', false).eq('activo', true);
      if (estado === 'aprobado') query = query.eq('aprobado', true).eq('activo', true);
      const { data, error } = await query.order('nombre', { ascending: true });
      if (error) throw error;
      return res.json((data || []).map(toProfesorDto).filter(Boolean));
    } catch (error) {
      console.error('GET /api/admin/profesores-todos:', error?.message || error);
      return res.status(500).json({ error: 'No se pudieron cargar los instructores' });
    }
  });

  app.patch('/api/admin/profesores/:profesorId/aprobar', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const profesorId = profesorIdFromRequest(req);
      if (!profesorId) return res.status(400).json({ error: 'Instructor inválido' });
      const { data, error } = await supabaseAdmin
        .from('profesores')
        .update({ aprobado: true, activo: true })
        .eq('id', profesorId)
        .select(PROFESOR_ADMIN_SELECT)
        .single();
      if (error) throw error;
      return res.json(toProfesorDto(data));
    } catch (error) {
      console.error('PATCH /api/admin/profesores/:id/aprobar:', error?.message || error);
      return res.status(500).json({ error: 'No se pudo aprobar el instructor' });
    }
  });

  app.patch('/api/admin/profesores/:profesorId/rechazar', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const profesorId = profesorIdFromRequest(req);
      if (!profesorId) return res.status(400).json({ error: 'Instructor inválido' });
      const { data, error } = await supabaseAdmin
        .from('profesores')
        .update({ activo: false })
        .eq('id', profesorId)
        .select(PROFESOR_ADMIN_SELECT)
        .single();
      if (error) throw error;
      return res.json(toProfesorDto(data));
    } catch (error) {
      console.error('PATCH /api/admin/profesores/:id/rechazar:', error?.message || error);
      return res.status(500).json({ error: 'No se pudo rechazar el instructor' });
    }
  });

  app.patch('/api/admin/profesores/:profesorId', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const profesorId = profesorIdFromRequest(req);
      const updates = allowedProfessorUpdates(req.body);
      if (!profesorId || !Object.keys(updates).length) return res.status(400).json({ error: 'No hay cambios válidos' });
      const { data, error } = await supabaseAdmin
        .from('profesores')
        .update(updates)
        .eq('id', profesorId)
        .select(PROFESOR_ADMIN_SELECT)
        .single();
      if (error) throw error;
      return res.json(toProfesorDto(data));
    } catch (error) {
      console.error('PATCH /api/admin/profesores/:id:', error?.message || error);
      return res.status(500).json({ error: 'No se pudo actualizar el instructor' });
    }
  });
}

