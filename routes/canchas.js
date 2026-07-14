import {
  buildCanchaDeporteWritePatch,
  isMissingCanchaCustomColumnError,
  mapCanchaPublicDto,
  validateCanchaNombreVisible,
} from '../lib/canchaDeporteCustom.js';
import { requireSedeAdminForId } from '../lib/authAccess.js';

function parsePositiveId(raw) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeEstadoCancha(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'inactiva' || s === 'inactive' || s === 'false') return 'inactiva';
  return 'activa';
}

function canchasConNumeroReserva(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => Number(a.id) - Number(b.id));
  return list.map((c, i) => {
    const o = c.orden != null && c.orden !== '' ? Number(c.orden) : NaN;
    const numero_reserva = Number.isFinite(o) && o > 0 ? o : i + 1;
    return { ...c, numero_reserva };
  });
}

function mapCanchaAdminDto(row, allRowsSameSede) {
  const enriched = canchasConNumeroReserva(allRowsSameSede);
  const hit = enriched.find((c) => Number(c.id) === Number(row.id));
  const dto = mapCanchaPublicDto(row, { orden: hit ? hit.numero_reserva : null });
  return dto;
}

function migrationPendingResponse(res) {
  return res.status(503).json({
    error: 'Migración SQL de deporte custom pendiente (canchas_deporte_custom_migration.sql)',
    code: 'CANCHAS_CUSTOM_MIGRATION_REQUIRED',
  });
}

async function fetchCanchasRowsForSede(supabaseAdmin, sedeId) {
  const { data, error } = await supabaseAdmin
    .from('canchas')
    .select('*')
    .eq('sede_id', sedeId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * CRUD canchas + listado público básico.
 * POST/PATCH: whitelist oficiales + custom (MEJ-07). No abre torneos a custom.
 */
export function mountCanchasRoutes(app, {
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

  /** GET público/ligero: canchas de una sede (compatible clientes actuales). */
  app.get('/api/canchas', async (req, res) => {
    try {
      const sedeId = parsePositiveId(req.query.sede_id);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id query param es requerido' });
      }

      const { data, error } = await supabaseAdmin
        .from('canchas')
        .select('*')
        .eq('sede_id', sedeId)
        .order('id', { ascending: true });

      if (error) throw error;

      const rows = data || [];
      return res.json({
        canchas: rows.map((r) => {
          const dto = mapCanchaPublicDto(r);
          // Compat shape histórico: id, nombre, deporte, sede_id, estado (+ nuevos).
          return {
            id: dto.id,
            nombre: dto.nombre,
            deporte: dto.deporte,
            sede_id: dto.sede_id,
            estado: dto.estado,
            deporte_personalizado: dto.deporte_personalizado,
            deporte_label: dto.deporte_label,
            cantidad_jugadores: dto.cantidad_jugadores,
            modalidad_custom: dto.modalidad_custom,
            duracion_sugerida_min: dto.duracion_sugerida_min,
            observacion_custom: dto.observacion_custom,
            es_deporte_personalizado: dto.es_deporte_personalizado,
          };
        }),
      });
    } catch (err) {
      console.error('❌ GET /api/canchas:', err.message);
      return res.status(500).json({ error: err.message || 'Error al obtener canchas' });
    }
  });

  /** GET admin: listado por sede (misma forma que monorepo). */
  app.get('/api/sedes/:id/canchas', async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID de sede inválido' });
      const auth = await requireSedeAdminForId(req, res, id, adminDeps);
      if (!auth) return;

      const rowsAll = await fetchCanchasRowsForSede(supabaseAdmin, id);
      const canchas = rowsAll.map((r) => mapCanchaAdminDto(r, rowsAll));
      return res.json({ canchas });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/sedes/:id/canchas:', err?.message || err);
      return res.status(500).json({ error: err.message || String(err) });
    }
  });

  /** POST admin: alta de cancha (oficial o custom). */
  app.post('/api/sedes/:id/canchas', async (req, res) => {
    try {
      const id = parsePositiveId(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID de sede inválido' });
      const auth = await requireSedeAdminForId(req, res, id, adminDeps);
      if (!auth) return;

      const b = req.body || {};
      const nombreVal = validateCanchaNombreVisible(b.nombre, { required: true });
      if (!nombreVal.ok) return res.status(nombreVal.status).json({ error: nombreVal.error });

      const estado = normalizeEstadoCancha(b.estado != null ? b.estado : 'activa');
      const descripcion =
        b.descripcion != null && String(b.descripcion).trim() !== ''
          ? String(b.descripcion).trim().slice(0, 500)
          : null;

      const depWrite = buildCanchaDeporteWritePatch(b, { mode: 'create' });
      if (!depWrite.ok) return res.status(depWrite.status).json({ error: depWrite.error });

      const existing = await fetchCanchasRowsForSede(supabaseAdmin, id);
      const enriched = canchasConNumeroReserva(existing);
      const nextOrden =
        enriched.length > 0 ? Math.max(...enriched.map((c) => c.numero_reserva)) + 1 : 1;

      const insertPayload = {
        sede_id: id,
        nombre: nombreVal.nombre,
        estado,
        orden: nextOrden,
        ...depWrite.patch,
      };
      if (descripcion) insertPayload.descripcion = descripcion;

      const { data: created, error } = await supabaseAdmin
        .from('canchas')
        .insert(insertPayload)
        .select('*')
        .single();
      if (error) {
        if (isMissingCanchaCustomColumnError(error)) return migrationPendingResponse(res);
        throw error;
      }

      const all = await fetchCanchasRowsForSede(supabaseAdmin, id);
      return res.status(201).json({ cancha: mapCanchaAdminDto(created, all) });
    } catch (err) {
      if (isMissingCanchaCustomColumnError(err)) return migrationPendingResponse(res);
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ POST /api/sedes/:id/canchas:', err?.message || err);
      return res.status(500).json({ error: err.message || String(err) });
    }
  });

  /** PATCH admin: actualización parcial. */
  app.patch('/api/canchas/:id', async (req, res) => {
    try {
      const cid = parsePositiveId(req.params.id);
      if (!cid) return res.status(400).json({ error: 'ID de cancha inválido' });

      const { data: row, error: e1 } = await supabaseAdmin
        .from('canchas')
        .select('*')
        .eq('id', cid)
        .maybeSingle();
      if (e1) throw e1;
      if (!row) return res.status(404).json({ error: 'Cancha no encontrada' });

      const auth = await requireSedeAdminForId(req, res, row.sede_id, adminDeps);
      if (!auth) return;

      const b = req.body || {};
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return res.status(400).json({ error: 'Body JSON inválido' });
      }

      const patch = {};
      const hop = (k) => Object.prototype.hasOwnProperty.call(b, k);

      if (hop('nombre')) {
        const nombreVal = validateCanchaNombreVisible(b.nombre, { required: false });
        if (!nombreVal.ok) return res.status(nombreVal.status).json({ error: nombreVal.error });
        patch.nombre = nombreVal.nombre;
      }
      if (hop('estado')) patch.estado = normalizeEstadoCancha(b.estado);
      if (hop('descripcion')) {
        patch.descripcion =
          b.descripcion == null || String(b.descripcion).trim() === ''
            ? null
            : String(b.descripcion).trim().slice(0, 500);
      }

      const touchDeporte = hop('deporte') || [
        'deporte_personalizado',
        'cantidad_jugadores',
        'modalidad_custom',
        'duracion_sugerida_min',
        'observacion_custom',
      ].some((k) => hop(k));

      if (touchDeporte) {
        const depWrite = buildCanchaDeporteWritePatch(b, { mode: 'patch', existing: row });
        if (!depWrite.ok) return res.status(depWrite.status).json({ error: depWrite.error });
        Object.assign(patch, depWrite.patch);
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Ningún campo reconocido para actualizar' });
      }

      const { data: updated, error } = await supabaseAdmin
        .from('canchas')
        .update(patch)
        .eq('id', cid)
        .select('*')
        .single();
      if (error) {
        if (isMissingCanchaCustomColumnError(error)) return migrationPendingResponse(res);
        throw error;
      }
      if (!updated) return res.status(404).json({ error: 'Cancha no encontrada' });

      const all = await fetchCanchasRowsForSede(supabaseAdmin, row.sede_id);
      return res.json({ cancha: mapCanchaAdminDto(updated, all) });
    } catch (err) {
      if (isMissingCanchaCustomColumnError(err)) return migrationPendingResponse(res);
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ PATCH /api/canchas/:id:', err?.message || err);
      return res.status(500).json({ error: err.message || String(err) });
    }
  });
}
