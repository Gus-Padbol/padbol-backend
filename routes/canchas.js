function parseSedeId(raw) {
  const sid = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

export function mountCanchasRoutes(app, { supabaseAdmin }) {
  app.get('/api/canchas', async (req, res) => {
    try {
      const sedeId = parseSedeId(req.query.sede_id);
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id query param es requerido' });
      }

      console.log('[GET /api/canchas] query:', {
        table: 'canchas',
        sede_id: sedeId,
        select: 'id, nombre, deporte, sede_id, estado',
      });

      const { data, error } = await supabaseAdmin
        .from('canchas')
        .select('id, nombre, deporte, sede_id, estado')
        .eq('sede_id', sedeId);

      console.log('[GET /api/canchas] result count:', (data || []).length);

      if (error) throw error;

      return res.json({ canchas: data || [] });
    } catch (err) {
      console.error('❌ GET /api/canchas:', err.message);
      return res.status(500).json({ error: err.message || 'Error al obtener canchas' });
    }
  });
}
