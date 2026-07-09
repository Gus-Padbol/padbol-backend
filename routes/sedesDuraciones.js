import { requireSedeAdminForId } from '../lib/authAccess.js';
import { normalizeDeporteNullable, normalizeSurgeDeporte } from '../src/pricing/resolveReservaBasePrice.js';

function parseSedeId(raw) {
  const sid = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseRowId(raw) {
  const id = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parseDuracionMinutos(raw) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 15 || n > 480) return null;
  return n;
}

function parsePrecio(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function parseActivo(raw, defaultValue = true) {
  if (raw === undefined) return defaultValue;
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return defaultValue;
}

function isUniqueViolation(error) {
  return String(error?.code || '') === '23505';
}

function groupDuracionesByDeporte(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.deporte == null || String(row.deporte).trim() === ''
      ? '__base__'
      : String(row.deporte).trim().toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        deporte: key === '__base__' ? null : key,
        items: [],
      });
    }
    groups.get(key).items.push({
      id: row.id,
      duracion_minutos: row.duracion_minutos,
      precio: row.precio,
      activo: row.activo !== false,
    });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    items: g.items.sort((a, b) => a.duracion_minutos - b.duracion_minutos),
  }));
}

export function mountSedesDuracionesRoutes(app, {
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

  app.get('/api/sedes/:id/duraciones', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const auth = await requireSedeAdminForId(req, res, sid, adminDeps);
      if (!auth) return;

      let query = supabaseAdmin
        .from('sedes_duraciones')
        .select('id, sede_id, duracion_minutos, precio, activo, deporte')
        .eq('sede_id', sid)
        .order('duracion_minutos', { ascending: true });

      const deporteFilter = req.query.deporte;
      if (deporteFilter != null && String(deporteFilter).trim() !== '') {
        const dep = normalizeDeporteNullable(deporteFilter);
        if (dep == null) {
          query = query.is('deporte', null);
        } else {
          query = query.eq('deporte', dep);
        }
      }

      const { data, error } = await query;
      if (error) throw error;

      return res.json({ duraciones: data ?? [] });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/sedes/:id/duraciones:', err.message);
      return res.status(st).json({ error: err.message || 'Error al listar duraciones' });
    }
  });

  app.get('/api/sedes/:id/duraciones-disponibles', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      let query = supabaseAdmin
        .from('sedes_duraciones')
        .select('id, duracion_minutos, precio, deporte')
        .eq('sede_id', sid)
        .eq('activo', true)
        .order('duracion_minutos', { ascending: true });

      const deporteFilter = req.query.deporte;
      if (deporteFilter != null && String(deporteFilter).trim() !== '') {
        const dep = normalizeSurgeDeporte(deporteFilter);
        query = query.or(`deporte.eq.${dep},deporte.is.null`);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = data ?? [];
      if (deporteFilter != null && String(deporteFilter).trim() !== '') {
        return res.json({
          sede_id: sid,
          deporte: normalizeSurgeDeporte(deporteFilter),
          duraciones: rows.map((row) => ({
            id: row.id,
            duracion_minutos: row.duracion_minutos,
            precio: row.precio,
            deporte: row.deporte,
            es_base: row.deporte == null,
          })),
        });
      }

      return res.json({
        sede_id: sid,
        grupos: groupDuracionesByDeporte(rows),
      });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/sedes/:id/duraciones-disponibles:', err.message);
      return res.status(st).json({ error: err.message || 'Error al listar duraciones disponibles' });
    }
  });

  app.post('/api/sedes/:id/duraciones', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.id);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });

      const auth = await requireSedeAdminForId(req, res, sid, adminDeps);
      if (!auth) return;

      const body = req.body ?? {};
      const duracionMinutos = parseDuracionMinutos(body.duracion_minutos ?? body.duracion);
      const precio = parsePrecio(body.precio);
      if (duracionMinutos == null) {
        return res.status(400).json({ error: 'duracion_minutos inválida (15–480)' });
      }
      if (precio == null) {
        return res.status(400).json({ error: 'precio inválido (>= 0)' });
      }

      const deporte = normalizeDeporteNullable(body.deporte);
      const activo = parseActivo(body.activo, true);

      const row = {
        sede_id: sid,
        duracion_minutos: duracionMinutos,
        precio,
        activo,
        deporte,
      };

      const { data, error } = await supabaseAdmin
        .from('sedes_duraciones')
        .insert(row)
        .select('id, sede_id, duracion_minutos, precio, activo, deporte')
        .limit(1);

      if (error) {
        if (isUniqueViolation(error)) {
          return res.status(409).json({ error: 'Ya existe una duración con ese deporte y minutos' });
        }
        throw error;
      }

      const created = Array.isArray(data) ? data[0] : data;
      return res.status(201).json({ duracion: created });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/sedes/:id/duraciones:', err.message);
      return res.status(st).json({ error: err.message || 'Error al crear duración' });
    }
  });

  app.patch('/api/sedes/:id/duraciones/:rowId', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.id);
      const rowId = parseRowId(req.params.rowId);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });
      if (!rowId) return res.status(400).json({ error: 'rowId inválido' });

      const auth = await requireSedeAdminForId(req, res, sid, adminDeps);
      if (!auth) return;

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('sedes_duraciones')
        .select('id, sede_id, duracion_minutos, precio, activo, deporte')
        .eq('id', rowId)
        .eq('sede_id', sid)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!existing) return res.status(404).json({ error: 'Duración no encontrada' });

      const body = req.body ?? {};
      const patch = {};

      if (Object.prototype.hasOwnProperty.call(body, 'precio')) {
        const precio = parsePrecio(body.precio);
        if (precio == null) return res.status(400).json({ error: 'precio inválido (>= 0)' });
        patch.precio = precio;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'activo')) {
        patch.activo = parseActivo(body.activo, existing.activo !== false);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'deporte')) {
        patch.deporte = normalizeDeporteNullable(body.deporte);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'duracion_minutos') || Object.prototype.hasOwnProperty.call(body, 'duracion')) {
        const duracionMinutos = parseDuracionMinutos(body.duracion_minutos ?? body.duracion);
        if (duracionMinutos == null) {
          return res.status(400).json({ error: 'duracion_minutos inválida (15–480)' });
        }
        patch.duracion_minutos = duracionMinutos;
      }

      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'Sin campos para actualizar' });
      }

      const { data, error } = await supabaseAdmin
        .from('sedes_duraciones')
        .update(patch)
        .eq('id', rowId)
        .eq('sede_id', sid)
        .select('id, sede_id, duracion_minutos, precio, activo, deporte')
        .limit(1);

      if (error) {
        if (isUniqueViolation(error)) {
          return res.status(409).json({ error: 'Ya existe una duración con ese deporte y minutos' });
        }
        throw error;
      }

      const updated = Array.isArray(data) ? data[0] : data;
      return res.json({ duracion: updated });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ PATCH /api/sedes/:id/duraciones/:rowId:', err.message);
      return res.status(st).json({ error: err.message || 'Error al actualizar duración' });
    }
  });

  app.delete('/api/sedes/:id/duraciones/:rowId', async (req, res) => {
    try {
      const sid = parseSedeId(req.params.id);
      const rowId = parseRowId(req.params.rowId);
      if (!sid) return res.status(400).json({ error: 'sede_id inválido' });
      if (!rowId) return res.status(400).json({ error: 'rowId inválido' });

      const auth = await requireSedeAdminForId(req, res, sid, adminDeps);
      if (!auth) return;

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('sedes_duraciones')
        .select('id, sede_id')
        .eq('id', rowId)
        .eq('sede_id', sid)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!existing) return res.status(404).json({ error: 'Duración no encontrada' });

      const { data, error } = await supabaseAdmin
        .from('sedes_duraciones')
        .update({ activo: false })
        .eq('id', rowId)
        .eq('sede_id', sid)
        .select('id, sede_id, duracion_minutos, precio, activo, deporte')
        .limit(1);

      if (error) throw error;

      const updated = Array.isArray(data) ? data[0] : data;
      return res.json({ duracion: updated, soft_deleted: true });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ DELETE /api/sedes/:id/duraciones/:rowId:', err.message);
      return res.status(st).json({ error: err.message || 'Error al desactivar duración' });
    }
  });
}
