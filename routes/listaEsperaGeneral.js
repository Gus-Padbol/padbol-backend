import { resolveAuthRoleForUser } from '../lib/authAccess.js';
import { readWaitlistForSede, readWaitlistProfiles } from './waitlistRead.js';

function parseSedeId(raw) {
  const sid = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseDeporte(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase().slice(0, 64);
  return s || null;
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

  return readWaitlistProfiles(supabaseAdmin, userIds, 'user_id, nombre, apellido, apodo, username, email');
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
    let waitlistUser = null;
    let waitlistTuple = null;
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const { sedeId, deporte } = parseSedeDeporteFromRequest(req);
      waitlistUser = user;
      waitlistTuple = { sedeId, deporte };
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
          registrado: true,
          deporte,
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
        registrado: true,
        deporte,
        message: 'Te anotaste en la lista de espera',
        entry: data,
      });
    } catch (err) {
      // A concurrent identical POST may win the unique insert after our
      // SELECT saw no row. Reread that exact tuple and return the established
      // 200/already_registered contract. Never fabricate a row if the reread
      // is absent or fails.
      if (err?.code === '23505' && waitlistUser && waitlistTuple) {
        try {
          const { data: existing, error: rereadErr } = await supabaseAdmin
            .from('lista_espera_general')
            .select('id, sede_id, user_id, deporte, created_at')
            .eq('sede_id', waitlistTuple.sedeId)
            .eq('user_id', waitlistUser.id)
            .eq('deporte', waitlistTuple.deporte)
            .maybeSingle();
          if (!rereadErr && existing) {
            return res.status(200).json({
              ok: true,
              already_registered: true,
              registrado: true,
              deporte: waitlistTuple.deporte,
              message: 'Ya estás anotado',
              entry: existing,
            });
          }
        } catch {
          // Fall through to the original failure; no false success.
        }
      }
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

  // Compatibility for the native client: own status by sede, sport optional.
  // Existing /check contract stays unchanged.
  app.get('/api/lista-espera-general', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status || 401).json({ error: authError || 'Inicia sesión' });
      const rawSede = String(req.query?.sede_id ?? '').trim();
      const sedeId = Number(rawSede);
      if (!/^\d+$/.test(rawSede) || !Number.isSafeInteger(sedeId) || sedeId <= 0) {
        return res.status(400).json({ error: 'sede_id inválido o faltante' });
      }
      const deporte = parseDeporte(req.query?.deporte);
      let query = supabaseAdmin.from('lista_espera_general')
        .select('id, deporte, created_at')
        .eq('sede_id', sedeId).eq('user_id', user.id);
      if (deporte) query = query.eq('deporte', deporte);
      const { data, error } = await query.order('created_at', { ascending: false })
        .limit(1).maybeSingle();
      if (error) throw error;
      return res.json({ registrado: Boolean(data), deporte: data?.deporte ?? null });
    } catch (err) {
      return res.status(err.status || 500).json({ error: 'No se pudo consultar la lista de espera' });
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

      const role = await resolveAuthRoleForUser(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      assertCanAdministerSede(role, sedeId);

      const list = await readWaitlistForSede(supabaseAdmin, 'lista_espera_general', sedeId);
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
