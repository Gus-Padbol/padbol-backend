// Isolated candidate. Do not mount until the occupancy migration and every
// writer have been reviewed and tested together in the target environment.
const ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function installScoreboardSuspensionRoutesCandidate(app, {
  getAuthenticatedUser, fetchPartido, resolveRole, assertCanControl, db, publishUpdate,
}) {
  for (const action of ['suspend', 'resume', 'reconcile']) {
    app.post(`/api/scoreboard/partidos/:id/${action}`, async (req, res) => {
      try {
        const auth = await getAuthenticatedUser(req);
        if (!auth.user) return res.status(auth.status || 401).json({ error: 'No autorizado' });
        const marker = await fetchPartido(db, req.params.id);
        assertCanControl(await resolveRole(auth.user), marker.sede_id);
        const actionId = req.body?.action_id;
        const mutation = action === 'reconcile' ? req.body?.action : action;
        if (typeof actionId !== 'string' || !ACTION_ID.test(actionId) || !['suspend','resume'].includes(mutation)) {
          return res.status(400).json({ error: 'Referencia de operación inválida.' });
        }
        let args = { p_action_id: actionId, p_action: mutation, p_id: marker.id, p_actor: auth.user.id };
        if (action !== 'reconcile') {
          const expected = req.body?.updated_at;
          if (typeof expected !== 'string' || !Number.isFinite(Date.parse(expected))) {
            return res.status(400).json({ error: 'Actualizá el marcador antes de continuar.' });
          }
          Object.assign(args, { p_expected: expected, p_court_id: null, p_duration: null });
          if (action === 'resume') {
            const court = req.body?.court_id; const duration = req.body?.duration_minutes;
            if (!Number.isSafeInteger(court) || court <= 0 || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
              return res.status(400).json({ error: 'Elegí una cancha y una duración válida.' });
            }
            Object.assign(args, { p_court_id: court, p_duration: duration });
          }
        }
        const rpc = action === 'reconcile' ? 'scoreboard_reconcile_isolated_candidate' : 'scoreboard_transition_receipt_isolated_candidate';
        const { data, error } = await db.rpc(rpc, args);
        if (error) {
          if (['23505','55000','0A000'].includes(error.code)) return res.status(409).json({ error: 'No se pudo completar el cambio; revisá el partido y la disponibilidad de la cancha.' });
          if (error.code === '42501') return res.status(403).json({ error: 'No autorizado' });
          if (error.code === '22023') return res.status(400).json({ error: 'Revisá la cancha y el horario elegidos.' });
          throw error;
        }
        if (!data || data.status === 'conflict') return res.status(409).json({ error: 'El marcador cambió. Actualizá y volvé a intentar.' });
        if (!(action === 'reconcile' ? ['applied','cancelled'] : ['applied','replayed']).includes(data.status)) throw new Error('Invalid transition receipt');
        // Fetch the latest marker on replay: the saved transition snapshot may
        // be older than subsequent points or state changes.
        const current = data.status === 'applied' && action !== 'reconcile' ? data.result : await fetchPartido(db, marker.id);
        const { control_token_hash, control_token_created_at, control_token_revoked_at, ...safe } = current;
        if (data.status === 'applied' && action !== 'reconcile') {
          try { await publishUpdate(safe); } catch { /* screen polling recovers */ }
        }
        return res.json({ ...safe, transition_receipt: { action_id: actionId, action: mutation, status: data.status } });
      } catch (error) {
        return res.status(error?.status === 403 ? 403 : 500).json({ error: error?.status === 403 ? 'No autorizado' : 'No se pudo confirmar el marcador.' });
      }
    });
  }
}
