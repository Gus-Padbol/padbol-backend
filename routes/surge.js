import { calculateSurgePrice, normalizeSurgeDeporte } from '../src/surge.js';

function parsePrecioSurge(raw, fieldName) {
  if (raw === null || raw === undefined || raw === '') {
    throw Object.assign(new Error(`${fieldName} es requerido`), { status: 400 });
  }
  const n = Number(String(raw).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`${fieldName} inválido`), { status: 400 });
  }
  return Math.round(n);
}

export function mountSurgeRoutes(app, { supabaseAdmin, getAuthenticatedUser }) {
  app.get('/api/surge/:sedeId/:deporte/:duracion', async (req, res) => {
    try {
      const result = await calculateSurgePrice(
        supabaseAdmin,
        req.params.sedeId,
        req.params.deporte,
        req.params.duracion,
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
        .select('id, sede_id, deporte, precio_minimo, precio_maximo, activo, updated_at')
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
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const body = req.body ?? {};
      const sedeId = parseInt(String(body.sede_id), 10);
      if (!Number.isFinite(sedeId) || sedeId <= 0) {
        return res.status(400).json({ error: 'sede_id inválido' });
      }

      const deporte = normalizeSurgeDeporte(body.deporte);
      const activo = body.activo === true || body.activo === 'true' || body.activo === 1;
      const precioMinimo = parsePrecioSurge(body.precio_minimo, 'precio_minimo');
      const precioMaximo = parsePrecioSurge(body.precio_maximo, 'precio_maximo');

      if (activo && (precioMinimo <= 0 || precioMaximo <= 0 || precioMaximo < precioMinimo)) {
        return res.status(400).json({ error: 'precio_maximo debe ser mayor o igual a precio_minimo' });
      }

      const row = {
        sede_id: sedeId,
        deporte,
        precio_minimo: precioMinimo,
        precio_maximo: precioMaximo,
        activo,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabaseAdmin
        .from('surge_config')
        .upsert(row, { onConflict: 'sede_id,deporte' })
        .select('id, sede_id, deporte, precio_minimo, precio_maximo, activo, updated_at')
        .single();

      if (error) throw error;
      return res.json({ config: data });
    } catch (err) {
      const st = err.status || 500;
      console.error('❌ POST /api/surge-config:', err.message);
      return res.status(st).json({ error: err.message || 'Error al guardar configuración Surge' });
    }
  });
}
