function parseSedeId(raw) {
  const sid = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseDeporte(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 64);
  return s || null;
}

async function resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails }) {
  const email = String(user.email || '').trim().toLowerCase();
  const row = await fetchUserRoleRowForAuthUser(user);
  if (!row && legacySuperAdminEmails.includes(email)) {
    return { rol: 'super_admin', sede_id: null };
  }
  const sedeIdRaw = row?.sede_id;
  const sedeIdNum = sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;
  return {
    rol: String(row?.role || '').trim().toLowerCase() || null,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
  };
}

function isSuperAdminRole(role) {
  return role.rol === 'super_admin';
}

function assertCanAdministerSede(role, sedeId) {
  if (isSuperAdminRole(role)) return;
  if (role.rol === 'admin_club' && role.sede_id != null && Number(role.sede_id) === Number(sedeId)) {
    return;
  }
  const err = new Error('No tenés permiso para administrar esta sede');
  err.status = 403;
  throw err;
}

async function assertSedeExists(supabaseAdmin, sedeId) {
  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id')
    .eq('id', sedeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Sede no encontrada');
    err.status = 404;
    throw err;
  }
}

function displayNameFromPerfil(perfil) {
  if (!perfil) return null;
  const apodo = perfil.apodo ? String(perfil.apodo).trim() : '';
  if (apodo) return apodo;
  const parts = [perfil.nombre, perfil.apellido].map((v) => (v ? String(v).trim() : '')).filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (perfil.username) return String(perfil.username).trim();
  return null;
}

function mapInteresRow(row, perfilByUserId) {
  const perfil = perfilByUserId.get(String(row.user_id)) ?? null;
  return {
    id: row.id,
    user_id: row.user_id,
    deporte: row.deporte ?? null,
    created_at: row.created_at ?? null,
    nombre: displayNameFromPerfil(perfil),
    email: perfil?.email ?? null,
    foto_url: perfil?.foto_url ?? null,
  };
}

async function fetchPerfilesByUserIds(supabaseAdmin, userIds) {
  const map = new Map();
  if (!userIds.length) return map;

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id, nombre, apellido, apodo, username, email, foto_url')
    .in('user_id', userIds);

  if (error) throw error;

  for (const row of data ?? []) {
    if (row?.user_id) map.set(String(row.user_id), row);
  }
  return map;
}

export function mountTorneoInteresRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.post('/api/sedes/:id/torneo-interes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      await assertSedeExists(supabaseAdmin, sid);

      const deporte = parseDeporte(req.body?.deporte);

      const { data, error } = await supabaseAdmin
        .from('torneo_interes')
        .upsert(
          { sede_id: sid, user_id: user.id, deporte },
          { onConflict: 'sede_id,user_id' },
        )
        .select('id, sede_id, user_id, deporte, created_at')
        .single();

      if (error) throw error;

      console.log(`✓ POST /api/sedes/${sid}/torneo-interes — user ${user.id}`);
      return res.status(201).json({
        ok: true,
        interes: data,
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/sedes/:id/torneo-interes:', err.message);
      return res.status(st).json({ error: err.message || 'Error al registrar interés' });
    }
  });

  app.delete('/api/sedes/:id/torneo-interes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const { data, error } = await supabaseAdmin
        .from('torneo_interes')
        .delete()
        .eq('sede_id', sid)
        .eq('user_id', user.id)
        .select('id')
        .maybeSingle();

      if (error) throw error;

      console.log(`✓ DELETE /api/sedes/${sid}/torneo-interes — user ${user.id}`);
      return res.json({
        ok: true,
        removed: Boolean(data),
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ DELETE /api/sedes/:id/torneo-interes:', err.message);
      return res.status(st).json({ error: err.message || 'Error al quitar interés' });
    }
  });

  app.get('/api/admin/sedes/:id/torneo-interes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanAdministerSede(role, sid);

      const { data: rows, error } = await supabaseAdmin
        .from('torneo_interes')
        .select('id, sede_id, user_id, deporte, created_at')
        .eq('sede_id', sid)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const list = rows ?? [];
      const userIds = [...new Set(list.map((row) => row.user_id).filter(Boolean))];
      const perfilByUserId = await fetchPerfilesByUserIds(supabaseAdmin, userIds);

      return res.json({
        sede_id: sid,
        count: list.length,
        interesados: list.map((row) => mapInteresRow(row, perfilByUserId)),
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/admin/sedes/:id/torneo-interes:', err.message);
      return res.status(st).json({ error: err.message || 'Error al listar interesados' });
    }
  });
}
