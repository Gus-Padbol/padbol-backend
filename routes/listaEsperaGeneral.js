function parseSedeId(raw) {
  const sid = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseDeporte(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase().slice(0, 64);
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

function resolveNombreFromPerfil(perfil) {
  if (!perfil) return null;
  const parts = [perfil.nombre, perfil.apellido].map((v) => (v ? String(v).trim() : '')).filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (perfil.username) return String(perfil.username).trim();
  return null;
}

function mapListaEsperaAdminRow(row, perfilByUserId) {
  const perfil = perfilByUserId.get(String(row.user_id)) ?? null;
  return {
    id: row.id,
    user_id: row.user_id,
    sede_id: row.sede_id,
    nombre: resolveNombreFromPerfil(perfil),
    apodo: perfil?.apodo ? String(perfil.apodo).trim() : null,
    email: perfil?.email ?? null,
    deporte: row.deporte ?? null,
    created_at: row.created_at ?? null,
  };
}

async function fetchPerfilesByUserIds(supabaseAdmin, userIds) {
  const map = new Map();
  if (!userIds.length) return map;

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id, nombre, apellido, apodo, username, email')
    .in('user_id', userIds);

  if (error) throw error;

  for (const row of data ?? []) {
    if (row?.user_id) map.set(String(row.user_id), row);
  }
  return map;
}

function parseSedeDeporteFromRequest(req, { requireSedeId = true, requireDeporte = true } = {}) {
  const body = req.body ?? {};
  const sedeId = parseSedeId(req.query?.sede_id ?? body.sede_id ?? body.sedeId);
  const deporte = parseDeporte(req.query?.deporte ?? body.deporte);

  if (requireSedeId && sedeId == null) {
    const err = new Error('sede_id inválido o faltante');
    err.status = 400;
    throw err;
  }
  if (requireDeporte && !deporte) {
    const err = new Error('deporte inválido o faltante');
    err.status = 400;
    throw err;
  }

  return { sedeId, deporte };
}

export function mountListaEsperaGeneralRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.post('/api/lista-espera-general', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const { sedeId, deporte } = parseSedeDeporteFromRequest(req);
      await assertSedeExists(supabaseAdmin, sedeId);

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('lista_espera_general')
        .select('id, sede_id, user_id, deporte, created_at')
        .eq('sede_id', sedeId)
        .eq('user_id', user.id)
        .eq('deporte', deporte)
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      if (existing) {
        return res.json({
          ok: true,
          already_registered: true,
          message: 'Ya estás anotado',
          entry: existing,
        });
      }

      const { data, error } = await supabaseAdmin
        .from('lista_espera_general')
        .insert({ sede_id: sedeId, user_id: user.id, deporte })
        .select('id, sede_id, user_id, deporte, created_at')
        .single();

      if (error) throw error;

      console.log(`✓ POST /api/lista-espera-general — user ${user.id} sede ${sedeId} ${deporte}`);
      return res.status(201).json({
        ok: true,
        already_registered: false,
        message: 'Te anotaste en la lista de espera',
        entry: data,
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/lista-espera-general:', err.message);
      return res.status(st).json({ error: err.message || 'Error al anotarse en la lista de espera' });
    }
  });

  app.delete('/api/lista-espera-general', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const { sedeId, deporte } = parseSedeDeporteFromRequest(req);

      const { data, error } = await supabaseAdmin
        .from('lista_espera_general')
        .delete()
        .eq('sede_id', sedeId)
        .eq('user_id', user.id)
        .eq('deporte', deporte)
        .select('id')
        .maybeSingle();

      if (error) throw error;

      console.log(`✓ DELETE /api/lista-espera-general — user ${user.id} sede ${sedeId} ${deporte}`);
      return res.json({
        ok: true,
        removed: Boolean(data),
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ DELETE /api/lista-espera-general:', err.message);
      return res.status(st).json({ error: err.message || 'Error al desanotarse de la lista de espera' });
    }
  });

  app.get('/api/lista-espera-general/check', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const { sedeId, deporte } = parseSedeDeporteFromRequest(req);

      const { data, error } = await supabaseAdmin
        .from('lista_espera_general')
        .select('id, sede_id, user_id, deporte, created_at')
        .eq('sede_id', sedeId)
        .eq('user_id', user.id)
        .eq('deporte', deporte)
        .maybeSingle();

      if (error) throw error;

      return res.json({
        anotado: Boolean(data),
        entry: data ?? null,
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/lista-espera-general/check:', err.message);
      return res.status(st).json({ error: err.message || 'Error al consultar lista de espera' });
    }
  });

  app.get('/api/admin/lista-espera-general/:sede_id', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseSedeId(req.params.sede_id);
      if (!sedeId) return res.status(400).json({ error: 'sede_id inválido' });

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanAdministerSede(role, sedeId);

      const { data: rows, error } = await supabaseAdmin
        .from('lista_espera_general')
        .select('id, sede_id, user_id, deporte, created_at')
        .eq('sede_id', sedeId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const list = rows ?? [];
      const userIds = [...new Set(list.map((row) => row.user_id).filter(Boolean))];
      const perfilByUserId = await fetchPerfilesByUserIds(supabaseAdmin, userIds);

      return res.json({
        sede_id: sedeId,
        count: list.length,
        lista: list.map((row) => mapListaEsperaAdminRow(row, perfilByUserId)),
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/admin/lista-espera-general/:sede_id:', err.message);
      return res.status(st).json({ error: err.message || 'Error al listar la lista de espera' });
    }
  });
}
