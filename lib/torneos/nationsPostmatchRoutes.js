import express from 'express';
import { assertNationsScoreboardAudience } from './nationsPublicAccess.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positive = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

async function resolveBoard(pool, id) {
  if (UUID.test(String(id))) return (await pool.query('SELECT * FROM public.scoreboard_partidos WHERE id=$1', [id])).rows[0] ?? null;
  const n = positive(id); if (!n) return null;
  return (await pool.query('SELECT * FROM public.scoreboard_partidos WHERE partido_torneo_id=$1 ORDER BY updated_at DESC LIMIT 1', [n])).rows[0] ?? null;
}

function send(res, job) {
  if (!job) return res.status(404).json({ ok: false, state: 'not_found', code: 'NATIONS_POSTMATCH_NOT_QUEUED' });
  const state = job.status === 'ready' ? 'ready'
    : job.status === 'insufficient' ? 'insufficient'
      : job.status === 'failed' ? 'failed'
        : job.status === 'uncertain' ? 'uncertain'
          : job.status === 'generating' || job.status === 'provider_started' ? 'generating' : 'queued';
  if (state === 'ready') return res.status(200).json({ ok: true, state, resumen: { ...job.summary, observed: job.observed, generated_at: job.updated_at } });
  if (state === 'insufficient') return res.status(409).json({ ok: false, state, code: 'NATIONS_POSTMATCH_INSUFFICIENT_DATA' });
  if (state === 'failed') return res.status(409).json({ ok: false, state, code: 'NATIONS_POSTMATCH_FAILED' });
  if (state === 'uncertain') return res.status(409).json({ ok: false, state, code: 'NATIONS_POSTMATCH_REVIEW_REQUIRED' });
  return res.status(202).json({ ok: true, state, resumen: null });
}

export function mountNationsPostmatchRoutes(app, { pool, supabaseAdmin, getAuthenticatedUser, getRole, enabled = false } = {}) {
  const handler = async (req, res) => {
    try {
      if (!enabled || !pool || !supabaseAdmin) return res.status(503).json({ ok: false, error: 'Servicio Nations postpartido no disponible' });
      const auth = await getAuthenticatedUser(req);
      if (!auth?.user) return res.status(auth?.status || 401).json({ ok: false, error: auth?.error || 'No autenticado' });
      const board = await resolveBoard(pool, req.params.id);
      if (!board) return res.status(404).json({ ok: false, error: 'Partido no encontrado' });
      // Reuse the approved Nations audience, never a new global role. This
      // requires a Bearer user and permits admin/participant or an authenticated
      // spectator once the parent tournament approved public reveal.
      await assertNationsScoreboardAudience(req, board, { db: supabaseAdmin, getAuthenticatedUser, getRole });
      if (req.method === 'POST') {
        const out = await (await import('./nationsPostmatchAi.js')).enqueueNationsPostmatchForPartido({ pool, torneoId: board.torneo_id, partidoId: board.partido_torneo_id });
        if (out.status === 'unavailable') return res.status(503).json({ ok: false, state: 'unavailable', code: 'NATIONS_POSTMATCH_SCHEMA_NOT_READY' });
        if (out.status === 'insufficient') return res.status(409).json({ ok: false, state: 'insufficient', code: 'NATIONS_POSTMATCH_INSUFFICIENT_DATA' });
        if (out.status === 'invalid') return res.status(400).json({ ok: false, error: 'IDs inválidos' });
      }
      const job = (await pool.query(`SELECT status,summary,observed,updated_at,error_code FROM nations_postmatch_ai.jobs
        WHERE scoreboard_id=$1 ORDER BY created_at DESC LIMIT 1`, [String(board.id)])).rows[0];
      return send(res, job);
    } catch (error) {
      if (error?.code === 'NATIONS_REVEAL_PENDING' || error?.status === 403) return res.status(403).json({ ok: false, error: 'Audiencia Nations no autorizada', code: error.code || 'FORBIDDEN' });
      return res.status(503).json({ ok: false, error: 'No se pudo consultar el resumen Nations.', code: 'NATIONS_POSTMATCH_UNAVAILABLE' });
    }
  };
  app.get('/api/nations/partidos/:id/resumen', handler);
  app.post('/api/nations/partidos/:id/resumen', express.json(), handler);
}
