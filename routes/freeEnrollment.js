import { confirmarInscripcionGratuitaAtomica } from '../lib/torneos/inscripcionGratuita.js';

function parseEnrollmentId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function mountFreeEnrollmentRoute(app, { getAuthenticatedUser, pool, logError = () => {} }) {
app.post('/api/torneos/confirmar-inscripcion', async (req, res) => {
  try {
    const auth = await getAuthenticatedUser(req);
    if (!auth.user) return res.status(auth.status || 401).json({ error: auth.error || 'Inicia sesión.', code: 'AUTH_REQUIRED' });
    const torneoId = parseEnrollmentId(req.body?.torneo_id);
    const equipoId = parseEnrollmentId(req.body?.equipo_id);
    if (torneoId === null || equipoId === null) {
      return res.status(400).json({ error: 'equipo_id y torneo_id son requeridos.', code: 'ENROLLMENT_INVALID' });
    }
    // Sin pgPool la confirmación falla cerrada (503); nunca usa el patrón inseguro count+update.
    const decision = await confirmarInscripcionGratuitaAtomica({
      pool,
      torneoId,
      equipoId,
      actor: auth.user,
    });
    return res.json(decision);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message, code: err.code || 'ENROLLMENT_REJECTED' });
    logError(err);
    return res.status(500).json({ error: 'No se pudo confirmar la inscripción.', code: 'ENROLLMENT_FAILED' });
  }
});
}
