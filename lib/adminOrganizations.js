const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeOrganizationId(value) {
  const id = String(value || '').trim().toLowerCase();
  return UUID_RE.test(id) ? id : null;
}

export function buildOrganizationPayload(body = {}, { partial = false } = {}) {
  const nombre = String(body.nombre || '').trim();
  if (!partial && !nombre) {
    const error = new Error('Nombre de la organización obligatorio');
    error.status = 400;
    throw error;
  }
  const payload = {};
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'nombre')) {
    if (!nombre) {
      const error = new Error('Nombre de la organización obligatorio');
      error.status = 400;
      throw error;
    }
    payload.nombre = nombre;
  }
  const nullableText = ['nombre_legal', 'pais_principal', 'email_contacto', 'whatsapp_contacto'];
  for (const key of nullableText) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, key)) {
      payload[key] = String(body[key] || '').trim() || null;
    }
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'plan_codigo')) {
    payload.plan_codigo = String(body.plan_codigo || 'business').trim().toLowerCase() || 'business';
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'estado')) {
    const estado = String(body.estado || 'activa').trim().toLowerCase();
    if (!['activa', 'pausada', 'baja'].includes(estado)) {
      const error = new Error('Estado de organización inválido');
      error.status = 400;
      throw error;
    }
    payload.estado = estado;
  }
  for (const key of ['limite_sedes', 'limite_canchas_total', 'limite_admins_centrales']) {
    if (!partial || Object.prototype.hasOwnProperty.call(body, key)) {
      const value = Number.parseInt(String(body[key] ?? '1'), 10);
      if (!Number.isFinite(value) || value <= 0) {
        const error = new Error(`${key} debe ser mayor a cero`);
        error.status = 400;
        throw error;
      }
      payload[key] = value;
    }
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'funciones_habilitadas')) {
    const defaults = ['reservas', 'torneos', 'jugadores', 'reportes'];
    const allowed = new Set(['reservas', 'torneos', 'jugadores', 'reportes', 'notificaciones', 'scoreboard']);
    const values = Array.isArray(body.funciones_habilitadas) ? body.funciones_habilitadas : defaults;
    payload.funciones_habilitadas = [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter((value) => allowed.has(value)))];
    if (!payload.funciones_habilitadas.length) {
      const error = new Error('Habilitá al menos una función para la cadena');
      error.status = 400;
      throw error;
    }
  }
  payload.updated_at = new Date().toISOString();
  return payload;
}

async function loadOrganizationsBundle(supabase, organizationIds) {
  const ids = [...new Set((organizationIds || []).map(normalizeOrganizationId).filter(Boolean))];
  if (!ids.length) return [];
  const [orgRes, linksRes, adminsRes] = await Promise.all([
    supabase.from('organizaciones').select('*').in('id', ids).order('nombre', { ascending: true }),
    supabase.from('organizacion_sedes').select('organizacion_id, sede_id, created_at').in('organizacion_id', ids),
    supabase
      .from('user_roles')
      .select('email, nombre, role, organizacion_id, created_at')
      .eq('role', 'admin_cadena')
      .in('organizacion_id', ids)
      .order('email', { ascending: true }),
  ]);
  if (orgRes.error) throw orgRes.error;
  if (linksRes.error) throw linksRes.error;
  if (adminsRes.error) throw adminsRes.error;

  const links = linksRes.data || [];
  const sedeIds = [...new Set(links.map((row) => Number(row.sede_id)).filter(Number.isFinite))];
  let sedes = [];
  let sedeJugadores = [];
  let canchas = [];
  if (sedeIds.length) {
    const [sedesRes, jugadoresRes, canchasRes] = await Promise.all([
      supabase
        .from('sedes')
        .select('id, nombre, ciudad, provincia, pais, cantidad_canchas, licencia_activa, estado, email_contacto, telefono')
        .in('id', sedeIds)
        .order('nombre', { ascending: true }),
      supabase
        .from('sede_jugadores')
        .select('sede_id, user_id')
        .in('sede_id', sedeIds)
        .eq('estado', 'activo'),
      supabase.from('canchas').select('id, sede_id').in('sede_id', sedeIds),
    ]);
    if (sedesRes.error) throw sedesRes.error;
    if (jugadoresRes.error) throw jugadoresRes.error;
    if (canchasRes.error) throw canchasRes.error;
    sedes = sedesRes.data || [];
    sedeJugadores = jugadoresRes.data || [];
    canchas = canchasRes.data || [];
  }
  const sedeById = new Map(sedes.map((row) => [Number(row.id), row]));

  return (orgRes.data || []).map((org) => {
    const orgLinks = links.filter((row) => row.organizacion_id === org.id);
    const orgSedeIds = new Set(orgLinks.map((row) => Number(row.sede_id)));
    const orgSedes = orgLinks
      .filter((row) => row.organizacion_id === org.id)
      .map((row) => ({ ...sedeById.get(Number(row.sede_id)), vinculada_at: row.created_at }))
      .filter((row) => row.id != null);
    const jugadoresIds = new Set(
      sedeJugadores
        .filter((row) => orgSedeIds.has(Number(row.sede_id)))
        .map((row) => String(row.user_id || '').trim())
        .filter(Boolean),
    );
    const canchasPorSede = new Map();
    for (const cancha of canchas) {
      const sid = Number(cancha.sede_id);
      canchasPorSede.set(sid, (canchasPorSede.get(sid) || 0) + 1);
    }
    const canchasTotal = orgSedes.reduce((total, sede) => {
      const reales = canchasPorSede.get(Number(sede.id)) || 0;
      const declaradas = Number(sede.cantidad_canchas) || 0;
      return total + Math.max(reales, declaradas);
    }, 0);
    return {
      ...org,
      sedes: orgSedes,
      administradores: (adminsRes.data || []).filter((row) => row.organizacion_id === org.id),
      resumen: {
        sedes_total: orgSedes.length,
        canchas_total: canchasTotal,
        jugadores_vinculados_total: jugadoresIds.size,
      },
    };
  });
}

export function registerAdminOrganizationsRoutes(app, deps) {
  const {
    supabase,
    adminListScopeFromRequest,
    assertSuperAdminReq,
    generateAdminInviteMagicLink,
  } = deps;

  app.get('/api/admin/organizaciones', async (req, res) => {
    try {
      const scope = await adminListScopeFromRequest(req);
      if (!scope) return res.status(401).json({ error: 'No autorizado' });
      let ids = [];
      if (scope.superA) {
        const { data, error } = await supabase.from('organizaciones').select('id').order('nombre', { ascending: true });
        if (error) throw error;
        ids = (data || []).map((row) => row.id);
      } else if (scope.rol === 'admin_cadena' && scope.organizacionId) {
        ids = [scope.organizacionId];
      } else {
        return res.status(403).json({ error: 'Sin permiso para administrar organizaciones' });
      }
      return res.json(await loadOrganizationsBundle(supabase, ids));
    } catch (error) {
      console.error('❌ GET /api/admin/organizaciones:', error.message);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/admin/organizaciones', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const payload = buildOrganizationPayload(req.body || {});
      const { data, error } = await supabase.from('organizaciones').insert(payload).select('*').single();
      if (error) throw error;
      return res.status(201).json({ ...data, sedes: [], administradores: [] });
    } catch (error) {
      console.error('❌ POST /api/admin/organizaciones:', error.message);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.patch('/api/admin/organizaciones/:id', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const id = normalizeOrganizationId(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID de organización inválido' });
      const payload = buildOrganizationPayload(req.body || {}, { partial: true });
      const current = (await loadOrganizationsBundle(supabase, [id]))[0];
      if (!current) return res.status(404).json({ error: 'Organización no encontrada' });
      if (payload.limite_sedes != null && payload.limite_sedes < Number(current.resumen?.sedes_total || 0)) {
        return res.status(409).json({ error: 'El cupo de sedes no puede ser menor que las sedes ya vinculadas' });
      }
      if (payload.limite_canchas_total != null && payload.limite_canchas_total < Number(current.resumen?.canchas_total || 0)) {
        return res.status(409).json({ error: 'El cupo de canchas no puede ser menor que las canchas ya habilitadas' });
      }
      if (payload.limite_admins_centrales != null && payload.limite_admins_centrales < Number(current.administradores?.length || 0)) {
        return res.status(409).json({ error: 'El cupo de administradores no puede ser menor que los accesos centrales activos' });
      }
      const { data, error } = await supabase.from('organizaciones').update(payload).eq('id', id).select('*').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Organización no encontrada' });
      return res.json(data);
    } catch (error) {
      console.error('❌ PATCH /api/admin/organizaciones/:id:', error.message);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/admin/organizaciones/:id/sedes', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const organizacionId = normalizeOrganizationId(req.params.id);
      const sedeId = Number(req.body?.sede_id);
      if (!organizacionId) return res.status(400).json({ error: 'ID de organización inválido' });
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id inválido' });
      const { data: sede, error: sedeError } = await supabase.from('sedes').select('id, nombre, cantidad_canchas').eq('id', sedeId).maybeSingle();
      if (sedeError) throw sedeError;
      if (!sede) return res.status(404).json({ error: 'Sede no encontrada' });
      const bundle = await loadOrganizationsBundle(supabase, [organizacionId]);
      const organization = bundle[0];
      if (!organization) return res.status(404).json({ error: 'Organización no encontrada' });
      if ((organization.sedes || []).length >= Number(organization.limite_sedes)) {
        return res.status(409).json({ error: `La cadena alcanzó su límite de ${organization.limite_sedes} sedes` });
      }
      const currentCourts = Number(organization.resumen?.canchas_total) || 0;
      const nextCourts = Number(sede.cantidad_canchas) || 0;
      if (currentCourts + nextCourts > Number(organization.limite_canchas_total)) {
        return res.status(409).json({ error: `La sede supera el límite total de ${organization.limite_canchas_total} canchas de la cadena` });
      }
      const { data, error } = await supabase
        .from('organizacion_sedes')
        .insert({ organizacion_id: organizacionId, sede_id: sedeId })
        .select('*')
        .single();
      if (error?.code === '23505') {
        return res.status(409).json({ error: 'La sede ya pertenece a una organización' });
      }
      if (error) throw error;
      return res.status(201).json({ ...data, sede });
    } catch (error) {
      console.error('❌ POST /api/admin/organizaciones/:id/sedes:', error.message);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.delete('/api/admin/organizaciones/:id/sedes/:sedeId', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const organizacionId = normalizeOrganizationId(req.params.id);
      const sedeId = Number(req.params.sedeId);
      if (!organizacionId || !Number.isFinite(sedeId)) return res.status(400).json({ error: 'Datos inválidos' });
      const { error } = await supabase
        .from('organizacion_sedes')
        .delete()
        .eq('organizacion_id', organizacionId)
        .eq('sede_id', sedeId);
      if (error) throw error;
      return res.json({ ok: true });
    } catch (error) {
      console.error('❌ DELETE /api/admin/organizaciones/:id/sedes/:sedeId:', error.message);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/admin/organizaciones/:id/administradores', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const organizacionId = normalizeOrganizationId(req.params.id);
      const email = String(req.body?.email || '').trim().toLowerCase();
      const nombre = String(req.body?.nombre || '').trim() || null;
      if (!organizacionId) return res.status(400).json({ error: 'ID de organización inválido' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });
      const bundle = await loadOrganizationsBundle(supabase, [organizacionId]);
      const organization = bundle[0];
      if (!organization) return res.status(404).json({ error: 'Organización no encontrada' });
      const alreadyAssigned = (organization.administradores || []).some((row) => row.email === email);
      if (!alreadyAssigned && (organization.administradores || []).length >= Number(organization.limite_admins_centrales)) {
        return res.status(409).json({ error: `La cadena alcanzó su límite de ${organization.limite_admins_centrales} administradores centrales` });
      }
      const rolePayload = {
        email,
        nombre,
        role: 'admin_cadena',
        alcance: 'organizacion',
        organizacion_id: organizacionId,
        sede_id: null,
        ciudad: null,
        provincia: null,
        pais: null,
        torneos_oficiales_habilitados: false,
      };
      const { data: existing, error: existingError } = await supabase
        .from('user_roles')
        .select('email')
        .eq('email', email)
        .maybeSingle();
      if (existingError) throw existingError;
      const write = existing?.email
        ? await supabase.from('user_roles').update(rolePayload).eq('email', email).select('*').single()
        : await supabase.from('user_roles').insert(rolePayload).select('*').single();
      if (write.error) throw write.error;
      let magicLink = null;
      try {
        const invite = await generateAdminInviteMagicLink({
          email,
          rol: 'admin_cadena',
          nombre,
          sede_id: null,
          assignRole: false,
        });
        magicLink = invite.magic_link;
      } catch (inviteError) {
        console.warn('⚠️ magic link admin_cadena:', inviteError.message);
      }
      return res.status(201).json({ ...write.data, magic_link: magicLink });
    } catch (error) {
      console.error('❌ POST /api/admin/organizaciones/:id/administradores:', error.message);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.delete('/api/admin/organizaciones/:id/administradores/:email', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const organizacionId = normalizeOrganizationId(req.params.id);
      const email = String(req.params.email || '').trim().toLowerCase();
      if (!organizacionId || !email) return res.status(400).json({ error: 'Datos inválidos' });
      const { error } = await supabase
        .from('user_roles')
        .delete()
        .eq('email', email)
        .eq('role', 'admin_cadena')
        .eq('organizacion_id', organizacionId);
      if (error) throw error;
      return res.json({ ok: true });
    } catch (error) {
      console.error('❌ DELETE /api/admin/organizaciones/:id/administradores/:email:', error.message);
      return res.status(error.status || 500).json({ error: error.message });
    }
  });
}
