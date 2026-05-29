function parseSedeId(raw) {
  const sid = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseExtraId(raw) {
  const id = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parsePrecio(raw) {
  const pr = Number(String(raw ?? '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(pr) && pr >= 0 ? Math.round(pr) : null;
}

function parseStock(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
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

export function mountSedeExtrasRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.get('/api/sedes/:id/extras-admin', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanAdministerSede(role, sid);

      const { data, error } = await supabaseAdmin
        .from('sede_extras')
        .select('*')
        .eq('sede_id', sid)
        .order('nombre', { ascending: true });

      if (error) throw error;
      return res.json({ extras: data || [] });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/sedes/:id/extras-admin:', err.message);
      return res.status(st).json({ error: err.message || 'Error al listar extras' });
    }
  });

  app.post('/api/sedes/:id/extras', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanAdministerSede(role, sid);

      const b = req.body || {};
      const nombre = String(b.nombre ?? '').trim();
      if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });

      const precio = parsePrecio(b.precio);
      if (precio == null) return res.status(400).json({ error: 'precio inválido' });

      const descripcion = b.descripcion != null ? String(b.descripcion).trim().slice(0, 2000) || null : null;
      const precio_moneda = String(b.precio_moneda || 'ARS').trim().toUpperCase().slice(0, 8) || 'ARS';
      const imagen_url = b.imagen_url != null ? String(b.imagen_url).trim().slice(0, 2000) || null : null;
      const activo = b.activo === undefined ? true : Boolean(b.activo);
      const stock = parseStock(b.stock);
      const aprobado_super = isSuperAdminRole(role) && Boolean(b.aprobado_super);

      const insertRow = {
        sede_id: sid,
        nombre: nombre.slice(0, 200),
        descripcion,
        precio,
        precio_moneda,
        imagen_url,
        activo,
        aprobado_super,
      };
      if (stock != null) insertRow.stock = stock;

      let result = await supabaseAdmin
        .from('sede_extras')
        .insert([insertRow])
        .select('*')
        .single();

      if (result.error && /stock/i.test(String(result.error.message || ''))) {
        delete insertRow.stock;
        result = await supabaseAdmin
          .from('sede_extras')
          .insert([insertRow])
          .select('*')
          .single();
      }

      if (result.error) throw result.error;
      return res.status(201).json({ extra: result.data });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/sedes/:id/extras:', err.message);
      return res.status(st).json({ error: err.message || 'Error al crear extra' });
    }
  });

  app.patch('/api/sedes/:id/extras/:extraId', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sid = parseSedeId(req.params.id);
      const extraId = parseExtraId(req.params.extraId);
      if (!sid || !extraId) return res.status(400).json({ error: 'Parámetros inválidos' });

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanAdministerSede(role, sid);

      const { data: existing, error: exErr } = await supabaseAdmin
        .from('sede_extras')
        .select('*')
        .eq('id', extraId)
        .maybeSingle();

      if (exErr) throw exErr;
      if (!existing || Number(existing.sede_id) !== sid) {
        return res.status(404).json({ error: 'Extra no encontrado en esta sede' });
      }

      const b = req.body || {};
      const patch = {};

      if (Object.prototype.hasOwnProperty.call(b, 'nombre')) {
        const n = String(b.nombre ?? '').trim();
        if (!n) return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
        patch.nombre = n.slice(0, 200);
      }
      if (Object.prototype.hasOwnProperty.call(b, 'descripcion')) {
        patch.descripcion = b.descripcion != null ? String(b.descripcion).trim().slice(0, 2000) || null : null;
      }
      if (Object.prototype.hasOwnProperty.call(b, 'precio')) {
        const precio = parsePrecio(b.precio);
        if (precio == null) return res.status(400).json({ error: 'precio inválido' });
        patch.precio = precio;
      }
      if (Object.prototype.hasOwnProperty.call(b, 'precio_moneda')) {
        patch.precio_moneda = String(b.precio_moneda || 'ARS').trim().toUpperCase().slice(0, 8) || 'ARS';
      }
      if (Object.prototype.hasOwnProperty.call(b, 'imagen_url')) {
        patch.imagen_url = b.imagen_url != null ? String(b.imagen_url).trim().slice(0, 2000) || null : null;
      }
      if (Object.prototype.hasOwnProperty.call(b, 'activo')) patch.activo = Boolean(b.activo);
      if (Object.prototype.hasOwnProperty.call(b, 'stock')) patch.stock = parseStock(b.stock);
      if (Object.prototype.hasOwnProperty.call(b, 'aprobado_super')) {
        if (!isSuperAdminRole(role)) {
          return res.status(403).json({ error: 'Solo super admin puede aprobar extras' });
        }
        patch.aprobado_super = Boolean(b.aprobado_super);
      }

      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'Nada que actualizar' });
      }

      let { data, error } = await supabaseAdmin
        .from('sede_extras')
        .update(patch)
        .eq('id', extraId)
        .select('*')
        .single();

      if (error && /stock/i.test(String(error.message || ''))) {
        delete patch.stock;
        ({ data, error } = await supabaseAdmin
          .from('sede_extras')
          .update(patch)
          .eq('id', extraId)
          .select('*')
          .single());
      }

      if (error) throw error;
      return res.json({ extra: data });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ PATCH /api/sedes/:id/extras/:extraId:', err.message);
      return res.status(st).json({ error: err.message || 'Error al actualizar extra' });
    }
  });

  app.delete('/api/sedes/:id/extras/:extraId', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sid = parseSedeId(req.params.id);
      const extraId = parseExtraId(req.params.extraId);
      if (!sid || !extraId) return res.status(400).json({ error: 'Parámetros inválidos' });

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanAdministerSede(role, sid);

      const { data: existing, error: exErr } = await supabaseAdmin
        .from('sede_extras')
        .select('id, sede_id')
        .eq('id', extraId)
        .maybeSingle();

      if (exErr) throw exErr;
      if (!existing || Number(existing.sede_id) !== sid) {
        return res.status(404).json({ error: 'Extra no encontrado en esta sede' });
      }

      const { error } = await supabaseAdmin.from('sede_extras').delete().eq('id', extraId);
      if (error) throw error;
      return res.json({ ok: true });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ DELETE /api/sedes/:id/extras/:extraId:', err.message);
      return res.status(st).json({ error: err.message || 'Error al eliminar extra' });
    }
  });
}
