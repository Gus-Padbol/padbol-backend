function parseSedeId(raw) {
  const sid = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseLiga(raw) {
  const liga = String(raw ?? '').trim().toUpperCase();
  return liga || null;
}

function parseFechaVencimiento(raw) {
  if (raw == null || raw === '') return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function isPremioVencido(fechaVencimiento) {
  if (!fechaVencimiento) return false;
  const venc = new Date(fechaVencimiento);
  return !Number.isNaN(venc.getTime()) && venc.getTime() < Date.now();
}

function mapPremioPublico(row) {
  if (!row || isPremioVencido(row.fecha_vencimiento)) return null;
  return {
    descripcion_premio: row.descripcion_premio,
    fecha_vencimiento: row.fecha_vencimiento ?? null,
  };
}

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('ligas_premios')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
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

function resolveAdminSedeId(role, source = {}) {
  if (role.rol === 'admin_club') {
    if (role.sede_id == null) {
      const err = new Error('Admin de club sin sede asignada');
      err.status = 403;
      throw err;
    }
    return role.sede_id;
  }

  if (isSuperAdminRole(role)) {
    const sid = parseSedeId(source.sede_id ?? source.sedeId);
    if (!sid) {
      const err = new Error('sede_id requerido');
      err.status = 400;
      throw err;
    }
    return sid;
  }

  const err = new Error('No autorizado');
  err.status = 403;
  throw err;
}

export function mountLigasPremiosRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.get('/api/ligas-premios/:sede_id/:liga', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.sede_id);
      const liga = parseLiga(req.params.liga);
      if (!sedeId || !liga) {
        return res.status(400).json({ error: 'sede_id o liga inválido' });
      }

      const { data, error } = await supabaseAdmin
        .from('ligas_premios')
        .select('descripcion_premio, fecha_vencimiento')
        .eq('sede_id', sedeId)
        .eq('liga', liga)
        .eq('activo', true)
        .maybeSingle();

      if (error) {
        if (isMissingTable(error)) return res.json({ premio: null });
        throw error;
      }

      return res.json({ premio: mapPremioPublico(data) });
    } catch (err) {
      console.error('❌ GET /api/ligas-premios/:sede_id/:liga:', err.message);
      return res.status(500).json({ error: err.message || 'Error al obtener premio' });
    }
  });

  app.get('/api/ligas-premios/:sede_id', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.params.sede_id);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id inválido' });
      }

      const { data, error } = await supabaseAdmin
        .from('ligas_premios')
        .select('liga, descripcion_premio, fecha_vencimiento')
        .eq('sede_id', sedeId)
        .eq('activo', true)
        .order('liga', { ascending: true });

      if (error) {
        if (isMissingTable(error)) return res.json({ premios: [] });
        throw error;
      }

      const premios = (data ?? [])
        .filter((row) => !isPremioVencido(row.fecha_vencimiento))
        .map((row) => ({
          liga: row.liga,
          descripcion_premio: row.descripcion_premio,
          fecha_vencimiento: row.fecha_vencimiento ?? null,
        }));

      return res.json({ premios });
    } catch (err) {
      console.error('❌ GET /api/ligas-premios/:sede_id:', err.message);
      return res.status(500).json({ error: err.message || 'Error al listar premios' });
    }
  });

  app.post('/api/admin/ligas-premios', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      const sedeId = resolveAdminSedeId(role, req.body ?? {});
      assertCanAdministerSede(role, sedeId);

      const liga = parseLiga(req.body?.liga);
      if (!liga) {
        return res.status(400).json({ error: 'liga es requerida' });
      }

      const descripcionPremio = String(req.body?.descripcion_premio ?? '').trim();
      if (!descripcionPremio) {
        return res.status(400).json({ error: 'descripcion_premio es requerido' });
      }

      const activo = req.body?.activo === undefined ? true : Boolean(req.body.activo);
      const fechaVencimiento = parseFechaVencimiento(req.body?.fecha_vencimiento);
      if (fechaVencimiento === undefined) {
        return res.status(400).json({ error: 'fecha_vencimiento inválida' });
      }

      const upsertRow = {
        sede_id: sedeId,
        liga,
        descripcion_premio: descripcionPremio.slice(0, 2000),
        activo,
        fecha_vencimiento: fechaVencimiento,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('ligas_premios')
        .upsert(upsertRow, { onConflict: 'sede_id,liga' })
        .select('sede_id, liga, descripcion_premio, activo, fecha_vencimiento, updated_at')
        .single();

      if (error) throw error;

      console.log(`✓ POST /api/admin/ligas-premios — sede ${sedeId}, liga ${liga}`);
      return res.json({ premio: data });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/admin/ligas-premios:', err.message);
      return res.status(st).json({ error: err.message || 'Error al guardar premio' });
    }
  });

  app.delete('/api/admin/ligas-premios/:liga', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const liga = parseLiga(req.params.liga);
      if (!liga) {
        return res.status(400).json({ error: 'liga inválida' });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      const sedeId = resolveAdminSedeId(role, {
        sede_id: req.query?.sede_id,
        sedeId: req.query?.sedeId,
      });
      assertCanAdministerSede(role, sedeId);

      const { data, error } = await supabaseAdmin
        .from('ligas_premios')
        .update({ activo: false, updated_at: new Date().toISOString() })
        .eq('sede_id', sedeId)
        .eq('liga', liga)
        .select('sede_id, liga, activo')
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({ error: 'Premio no encontrado' });
      }

      console.log(`✓ DELETE /api/admin/ligas-premios/${liga} — sede ${sedeId} desactivado`);
      return res.json({ ok: true, premio: data });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ DELETE /api/admin/ligas-premios/:liga:', err.message);
      return res.status(st).json({ error: err.message || 'Error al desactivar premio' });
    }
  });
}
