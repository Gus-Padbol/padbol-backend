// Endpoint real de preparación de marcadores; legacy por defecto y bulk sólo
// con flag exacto. La autorización se resuelve por middleware inyectado (el
// guard real de torneo) y nunca por actor/role del body.
export function registerNationsScoreboardGenerationRoute(app, {
  pool, supabaseAdmin, enabled = false, requireTorneoAdmin, generate, sendError, log = console.log, logError = console.error,
} = {}) {
  if (typeof requireTorneoAdmin !== 'function' || typeof generate !== 'function' || typeof sendError !== 'function') {
    throw new Error('SCOREBOARD_GENERATION_ROUTE_CONFIG_INVALID');
  }
  app.post('/api/torneos/:id/generar-scoreboards', async (req, res) => {
    try {
      const { id } = req.params;
      const auth = await requireTorneoAdmin(req, res, id);
      if (!auth) return;
      let result;
      if (enabled !== true) {
        result = await generate(supabaseAdmin, id, req.body ?? {});
      } else {
        if (!pool?.connect) return res.status(503).json({ error: 'Preparación temporalmente no disponible' });
        result = await generate(pool, id, req.body ?? {}, auth);
      }
      log(`✅ Scoreboards torneo ${id}: created=${result.created}, skipped=${result.skipped}, total=${result.items.length}`);
      res.json(result);
    } catch (err) {
      logError('❌ Error generar-scoreboards:', err.message);
      sendError(res, err);
    }
  });
}
