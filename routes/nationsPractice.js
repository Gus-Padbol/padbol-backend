import express from 'express';
import { getPracticeEvent, getPracticeBoard, practiceTournamentDto, practiceTeamsDto, practicePlayersDto, practiceMatchesDto, executePracticeAction, getPracticeMatchByBoard, practiceControlContext } from '../lib/torneos/nationsPractice.js';

function isVirtual(id) { const n = Number(id); return Number.isSafeInteger(n) && n >= 1_000_000_000_000 && n <= Number.MAX_SAFE_INTEGER; }

export function mountNationsPracticeRoutes(app, { pool, io = null, enabled = false } = {}) {
  if (!enabled || !pool) return;
  const load = async (id) => isVirtual(id) ? getPracticeEvent(pool, id) : null;
  const send = (res, fn) => res.json(fn());
  app.use('/api/torneos/:id', (req, res, next) => {
    if (!['GET','HEAD'].includes(req.method) && isVirtual(req.params.id)) return res.status(409).json({ ok: false, code: 'PRACTICE_LEGACY_MUTATION_REJECTED' });
    return next();
  });
  const getEvent = async (req, res, next) => { if (!isVirtual(req.params.id)) return next(); try { const data = await load(req.params.id); if (!data) return res.status(404).json({ ok: false, code: 'PRACTICE_EVENT_NOT_FOUND' }); req.practice = data; return next(); } catch (error) { return res.status(503).json({ ok: false, code: 'PRACTICE_READ_FAILED' }); } };
  const read = (path, fn) => app.get(path, getEvent, (req, res, next) => req.practice ? send(res, () => fn(req.practice)) : next());
  app.get('/api/torneos/:id', getEvent, (req, res, next) => req.practice ? send(res, () => practiceTournamentDto(req.practice.event)) : next());
  read('/api/torneos/:id/equipos', (d) => practiceTeamsDto(d.teams));
  read('/api/torneos/:id/jugadores', (d) => practicePlayersDto(d.teams));
  read('/api/torneos/:id/partidos', (d) => practiceMatchesDto(d.matches, d.event, d.teams));
  read('/api/torneos/:id/tabla', () => ({ equipos: [], filas: [], source: 'practice' }));
  read('/api/torneos/:id/tabla-posiciones', () => ({ equipos: [], filas: [], source: 'practice' }));
  read('/api/torneos/:id/tabla-puntos', () => ({ equipos: [], source: 'practice' }));
  read('/api/torneos/:id/permisos', () => ({ puedeAdministrar: false, puedeControlar: false, source: 'practice' }));

  app.get('/api/scoreboard/partidos/:id', async (req, res, next) => {
    try { const board = await getPracticeBoard(pool, req.params.id); if (!board) return next(); return res.json(board); }
    catch { return next(); }
  });

  const bearer = (req) => { const h = String(req.headers.authorization || ''); return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
  app.get('/api/practice/boards/:boardId/control', async (req, res) => {
    try {
      const ctx = await practiceControlContext({ pool, boardId: req.params.boardId, token: bearer(req) });
      if (!ctx) return res.status(404).json({ ok: false, code: 'PRACTICE_BOARD_NOT_FOUND' });
      return res.json({ ok: true, ...ctx });
    } catch (error) { return res.status(error?.status || 403).json({ ok: false, code: error?.code || 'PRACTICE_CONTROL_DENIED' }); }
  });
  app.post('/api/practice/boards/:boardId/commands', express.json(), async (req, res) => {
    try {
      const match = await getPracticeMatchByBoard(pool, req.params.boardId);
      if (!match) return res.status(404).json({ ok: false, code: 'PRACTICE_BOARD_NOT_FOUND' });
      const out = await executePracticeAction({ pool, matchId: match.id, action: req.body?.kind, requestId: req.body?.requestId, expectedRevision: req.body?.expectedRevision, body: req.body || {}, token: bearer(req) });
      const board = await getPracticeBoard(pool, req.params.boardId);
      try { io?.to(`scoreboard:${board.id}`).emit('scoreboard:update', board); } catch {}
      return res.json({ ok: true, board, revision: out.revision, deduplicated: out.deduplicated, state: out.state?.status || null });
    } catch (error) {
      const revision = error?.revision ?? null;
      return res.status(error?.status || 400).json({ ok: false, code: error?.code || 'PRACTICE_COMMAND_FAILED', ...(revision != null ? { revision } : {}) });
    }
  });
}
