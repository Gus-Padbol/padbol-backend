import { calculateSurgePrice, normalizeSurgeDeporte } from '../src/surge.js';
import { requireAdminUser } from '../lib/authAccess.js';

function parsePctSurge(raw, fieldName) {
  if (raw === null || raw === undefined || raw === '') {
    throw Object.assign(new Error(`${fieldName} es requerido`), { status: 400 });
  }
  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`${fieldName} inválido`), { status: 400 });
  }
  return n;
}

export function mountSurgeRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.get('/api/surge/:sedeId/:deporte/:duracion', async (req, res) => {
    try {
      const result = await calculateSurgePrice(
        supabaseAdmin,
        req.params.sedeId,
        req.params.deporte,
        req.params.duracion,
        { slot_inicio: req.query.slot_inicio ?? null },
      );
      return res.json(result);
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ GET /api/surge/:sedeId/:deporte/:duracion:', err.message);
      return res.status(st).json({ error: err.message || 'Error al calcular Surge' });
    }
  });

  app.get('/api/surge-config/:sedeId', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseInt(String(req.params.sedeId), 10);
      if (!Number.isFinite(sedeId) || sedeId <= 0) {
        return res.status(400).json({ error: 'sedeId inválido' });
      }

      const { data, error } = await supabaseAdmin
        .from('surge_config')
        .select('id, sede_id, deporte, descuento_max_pct, aumento_max_pct, activo, updated_at')
        .eq('sede_id', sedeId)
        .order('deporte', { ascending: true });

      if (error) throw error;
      return res.json({ configs: data ?? [] });
    } catch (err) {
      console.error('❌ GET /api/surge-config/:sedeId:', err.message);
      return res.status(500).json({ error: err.message || 'Error al cargar configuración Surge' });
    }
  });

  app.post('/api/surge-config', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, {
        getAuthenticatedUser,
        fetchUserRoleRowForAuthUser,
        legacySuperAdminEmails,
      });
      if (!auth) return;

      const body = req.body ?? {};
      const sedeId = parseInt(String(body.sede_id), 10);
      if (!Number.isFinite(sedeId) || sedeId <= 0) {
        return res.status(400).json({ error: 'sede_id inválido' });
      }

      if (auth.role.rol === 'admin_club' && auth.role.sede_id !== sedeId) {
        return res.status(403).json({ error: 'No tenés permiso para modificar Surge de otra sede' });
      }

      const deporte = normalizeSurgeDeporte(body.deporte);
      const activo = body.activo === true || body.activo === 'true' || body.activo === 1;
      const descuentoMaxPct = parsePctSurge(body.descuento_max_pct, 'descuento_max_pct');
      const aumentoMaxPct = parsePctSurge(body.aumento_max_pct, 'aumento_max_pct');

      if (activo && descuentoMaxPct > 100) {
        return res.status(400).json({ error: 'descuento_max_pct debe ser entre 0 y 100' });
      }

      const row = {
        sede_id: sedeId,
        deporte,
        descuento_max_pct: descuentoMaxPct,
        aumento_max_pct: aumentoMaxPct,
        activo,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('surge_config')
        .upsert(row, { onConflict: 'sede_id,deporte' })
        .select('id, sede_id, deporte, descuento_max_pct, aumento_max_pct, activo, updated_at')
        .limit(1);

      if (error) throw error;
      const config = Array.isArray(data) ? data[0] : data;
      return res.json({ config: config ?? null });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/surge-config:', err.message);
      return res.status(st).json({ error: err.message || 'Error al guardar configuración Surge' });
    }
  });
}
