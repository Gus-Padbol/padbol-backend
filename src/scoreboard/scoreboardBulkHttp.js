// HTTP boundary for bulk scoreboard preparation. Auth/scope are resolved by the
// existing admin middleware; body authority is never accepted. Feature OFF by
// default preserves the legacy Supabase route byte-for-byte in behavior.
export function createScoreboardBulkHandler({
  pool = null, supabaseAdmin, enabled = false, legacy, bulk,
} = {}) {
  if (typeof legacy !== 'function' || typeof bulk !== 'function') {
    throw new Error('SCOREBOARD_BULK_HANDLER_CONFIG_INVALID');
  }
  return async function handleBulkScoreboards(req, res, next) {
    const auth = req?.torneoAdminAuth;
    if (!auth?.user?.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const id = req.params?.id;
      const body = req.body ?? {};
      if (enabled !== true) {
        const result = await legacy(supabaseAdmin, id, body);
        return res.json(result);
      }
      if (!pool?.connect) return res.status(503).json({ error: 'Preparación temporalmente no disponible' });
      res.json(await bulk(pool, id, body, auth));
    } catch (error) {
      if (typeof next === 'function') return next(error);
      return res.status(Number(error?.status) || 500).json({ error: error?.message || 'Error' });
    }
  };
}
