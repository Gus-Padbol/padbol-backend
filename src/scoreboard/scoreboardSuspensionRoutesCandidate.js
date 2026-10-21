// Isolated candidate. Do not mount until the occupancy migration and every
// writer have been reviewed and tested together in the target environment.
export function installScoreboardSuspensionRoutesCandidate(app, {
  getAuthenticatedUser, fetchPartido, resolveRole, assertCanControl, db, publishUpdate,
}) {
  for (const action of ['suspend', 'resume']) {
    app.post(`/api/scoreboard/partidos/:id/${action}`, async (req, res) => {
      try {
        const auth = await getAuthenticatedUser(req);
        if (!auth.user) return res.status(auth.status || 401).json({ error: 'No autorizado' });
        const marker = await fetchPartido(db, req.params.id);
        assertCanControl(await resolveRole(auth.user), marker.sede_id);
        const expected = req.body?.updated_at;
        if (typeof expected !== 'string' || !Number.isFinite(Date.parse(expected))) {
          return res.status(400).json({ error: 'Actualizá el marcador antes de continuar.' });
        }
        const args = { p_id: marker.id, p_expected: expected, p_actor: auth.user.id };
        if (action === 'resume') {
          const court = req.body?.court_id; const duration = req.body?.duration_minutes;
          if (!Number.isSafeInteger(court) || court <= 0 || !Number.isInteger(duration) || duration < 1 || duration > 1440) {
            return res.status(400).json({ error: 'Elegí una cancha y una duración válida.' });
          }
          Object.assign(args, { p_court_id: court, p_duration_minutes: duration });
        }
        const { data, error } = await db.rpc(`scoreboard_${action}_candidate`, args);
        if (error) {
          if (['23505','55000','0A000'].includes(error.code)) return res.status(409).json({ error: 'No se pudo completar el cambio; revisá el partido y la disponibilidad de la cancha.' });
          if (error.code === '42501') return res.status(403).json({ error: 'No autorizado' });
          if (error.code === '22023') return res.status(400).json({ error: 'Revisá la cancha y el horario elegidos.' });
          throw error;
        }
        if (!data) return res.status(409).json({ error: 'El marcador cambió. Actualizá y volvé a intentar.' });
        // The commit already happened; an unavailable socket must never be
        // represented as a failed mutation and cause an unsafe retry.
        const { control_token_hash, control_token_created_at, control_token_revoked_at, ...safe } = data;
        try { await publishUpdate(safe); } catch { /* the screen polls for recovery */ }
        return res.json(safe);
      } catch (error) {
        return res.status(error?.status === 403 ? 403 : 500).json({ error: error?.status === 403 ? 'No autorizado' : 'No se pudo actualizar el marcador.' });
      }
    });
  }
}
