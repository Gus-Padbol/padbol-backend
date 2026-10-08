const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUuid = (value) => UUID_RE.test(String(value || '').trim());
const validId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const missingTable = (error) => /busca_dupla_|Could not find|schema cache|PGRST205|42P01/i.test(String(error?.message || error));
const fullName = (profile) => [profile?.nombre, profile?.apellido].map((v) => String(v || '').trim()).filter(Boolean).join(' ') || 'Jugador';

export function tournamentAllowsPartnerSearch(row, now = new Date()) {
  const state = String(row?.estado || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!state || ['finalizado', 'finalizada', 'cancelado', 'cancelada', 'en_curso'].includes(state)) return false;
  if (!row?.fecha_inicio) return true;
  return String(row.fecha_inicio).slice(0, 10) >= now.toISOString().slice(0, 10);
}

export function registeredPlayerIds(team) {
  return [...new Set((Array.isArray(team?.jugadores) ? team.jugadores : [])
    .filter((p) => String(p?.estado || '').toLowerCase() !== 'pendiente')
    .map((p) => String(p?.id || '').trim()).filter(validUuid))];
}

async function auth(req, res, getAuthenticatedUser) {
  const result = await getAuthenticatedUser(req);
  if (!result?.user?.id) {
    res.status(result?.status || 401).json({ error: result?.error || 'No autorizado' });
    return null;
  }
  return result.user;
}

async function hasTeam(db, tournamentId, user) {
  const { data, error } = await db.from('equipos').select('id,jugadores,creador_id').eq('torneo_id', tournamentId);
  if (error) throw error;
  const uid = String(user?.id || '');
  const email = String(user?.email || '').trim().toLowerCase();
  return (data || []).some((team) => String(team.creador_id || '') === uid
    || (Array.isArray(team.jugadores) ? team.jugadores : []).some((player) =>
      String(player?.id || '') === uid || (email && String(player?.email || '').trim().toLowerCase() === email)));
}

async function profile(db, userId, email = '') {
  let result = await db.from('jugadores_perfil')
    .select('user_id,email,nombre,apellido,alias,foto_url,whatsapp,nivel,lateralidad')
    .eq('user_id', userId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data && email) {
    result = await db.from('jugadores_perfil')
      .select('user_id,email,nombre,apellido,alias,foto_url,whatsapp,nivel,lateralidad')
      .ilike('email', email).maybeSingle();
    if (result.error) throw result.error;
  }
  return result.data;
}

async function cancelPending(db, tournamentId, userIds) {
  for (const uid of [...new Set(userIds.filter(validUuid))]) {
    const { error } = await db.from('busca_dupla_invitacion').update({ estado: 'cancelada' })
      .eq('torneo_id', tournamentId).eq('estado', 'pendiente')
      .or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
    if (error) throw error;
  }
}

function partnerError(res, error) {
  if (missingTable(error)) return res.status(503).json({
    error: 'La función Busca tu dupla requiere instalar sus tablas pendientes.',
    code: 'BUSCA_DUPLA_TABLE_MISSING',
  });
  return res.status(error?.status || 500).json({ error: error?.message || 'No se pudo completar la operación' });
}

export function mountBuscaDuplaRoutes(app, { supabaseAdmin: db, getAuthenticatedUser, now = () => new Date() }) {
  app.get('/api/torneos/:id/busca-dupla', async (req, res) => {
    try {
      if (!await auth(req, res, getAuthenticatedUser)) return;
      const tid = validId(req.params.id); if (!tid) return res.status(400).json({ error: 'ID inválido' });
      const { data: rows, error } = await db.from('busca_dupla_torneo').select('user_id,created_at')
        .eq('torneo_id', tid).order('created_at', { ascending: true });
      if (error) throw error;
      const ids = [...new Set((rows || []).map((row) => String(row.user_id)).filter(validUuid))];
      let profiles = [];
      if (ids.length) {
        const result = await db.from('jugadores_perfil')
          .select('user_id,nombre,apellido,alias,foto_url,whatsapp,nivel,lateralidad').in('user_id', ids);
        if (result.error) throw result.error;
        profiles = result.data || [];
      }
      const byId = new Map(profiles.map((row) => [String(row.user_id), row]));
      return res.json((rows || []).map((row) => {
        const p = byId.get(String(row.user_id));
        return { user_id: String(row.user_id), created_at: row.created_at, nombre: p ? fullName(p) : null,
          alias: String(p?.alias || ''), foto_url: String(p?.foto_url || ''), categoria: String(p?.nivel || ''),
          lateralidad: String(p?.lateralidad || ''), whatsapp: String(p?.whatsapp || '').trim() || null };
      }));
    } catch (error) { return partnerError(res, error); }
  });

  app.get('/api/torneos/:id/busca-dupla/me', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id); if (!tid) return res.status(400).json({ error: 'ID inválido' });
      const { data, error } = await db.from('busca_dupla_torneo').select('user_id').eq('torneo_id', tid).eq('user_id', user.id).maybeSingle();
      if (error) throw error; return res.json({ enrolled: Boolean(data) });
    } catch (error) { return partnerError(res, error); }
  });

  app.post('/api/torneos/:id/busca-dupla', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id); if (!tid) return res.status(400).json({ error: 'ID inválido' });
      const tournament = await db.from('torneos').select('id,estado,fecha_inicio').eq('id', tid).maybeSingle();
      if (tournament.error) throw tournament.error;
      if (!tournament.data) return res.status(404).json({ error: 'Torneo no encontrado' });
      if (!tournamentAllowsPartnerSearch(tournament.data, now())) return res.status(409).json({ error: 'El torneo no admite buscar dupla ahora' });
      if (await hasTeam(db, tid, user)) return res.status(409).json({ error: 'Ya tenés equipo en este torneo' });
      const inserted = await db.from('busca_dupla_torneo').insert({ torneo_id: tid, user_id: user.id });
      if (inserted.error && String(inserted.error.code) !== '23505') throw inserted.error;
      return res.json({ ok: true, already: String(inserted.error?.code || '') === '23505' });
    } catch (error) { return partnerError(res, error); }
  });

  app.delete('/api/torneos/:id/busca-dupla/me', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id); if (!tid) return res.status(400).json({ error: 'ID inválido' });
      const { error } = await db.from('busca_dupla_torneo').delete().eq('torneo_id', tid).eq('user_id', user.id);
      if (error) throw error; return res.json({ ok: true });
    } catch (error) { return partnerError(res, error); }
  });

  app.get('/api/torneos/:id/busca-dupla/invitaciones', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id); if (!tid) return res.status(400).json({ error: 'ID inválido' });
      const uid = String(user.id);
      const result = await db.from('busca_dupla_invitacion').select('id,from_user_id,to_user_id,created_at')
        .eq('torneo_id', tid).eq('estado', 'pendiente').or(`from_user_id.eq.${uid},to_user_id.eq.${uid}`);
      if (result.error) throw result.error;
      const ids = [...new Set((result.data || []).flatMap((row) => [row.from_user_id, row.to_user_id]).map(String).filter((id) => id !== uid && validUuid(id)))];
      let profiles = [];
      if (ids.length) { const found = await db.from('jugadores_perfil').select('user_id,nombre,apellido,alias,foto_url').in('user_id', ids); if (found.error) throw found.error; profiles = found.data || []; }
      const byId = new Map(profiles.map((row) => [String(row.user_id), row]));
      const enrich = (id) => { const p = byId.get(String(id)); return { otro_user_id: String(id), otro_nombre: p ? fullName(p) : null, otro_alias: String(p?.alias || ''), otro_foto_url: String(p?.foto_url || '') }; };
      return res.json({
        recibidas: (result.data || []).filter((r) => String(r.to_user_id) === uid).map((r) => ({ id: r.id, from_user_id: String(r.from_user_id), created_at: r.created_at, ...enrich(r.from_user_id) })),
        enviadas: (result.data || []).filter((r) => String(r.from_user_id) === uid).map((r) => ({ id: r.id, to_user_id: String(r.to_user_id), created_at: r.created_at, ...enrich(r.to_user_id) })),
      });
    } catch (error) { return partnerError(res, error); }
  });

  app.post('/api/torneos/:id/busca-dupla/invitar', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id); const target = String(req.body?.to_user_id || req.body?.user_id || '').trim();
      if (!tid || !validUuid(target) || target === String(user.id)) return res.status(400).json({ error: 'Invitación inválida' });
      const tournament = await db.from('torneos').select('id,estado,fecha_inicio').eq('id', tid).maybeSingle();
      if (tournament.error) throw tournament.error;
      if (!tournament.data) return res.status(404).json({ error: 'Torneo no encontrado' });
      if (!tournamentAllowsPartnerSearch(tournament.data, now())) return res.status(409).json({ error: 'El torneo no admite invitaciones ahora' });
      if (await hasTeam(db, tid, user) || await hasTeam(db, tid, { id: target })) return res.status(409).json({ error: 'Uno de los jugadores ya tiene equipo' });
      const [mine, theirs] = await Promise.all([
        db.from('busca_dupla_torneo').select('user_id').eq('torneo_id', tid).eq('user_id', user.id).maybeSingle(),
        db.from('busca_dupla_torneo').select('user_id').eq('torneo_id', tid).eq('user_id', target).maybeSingle(),
      ]);
      if (mine.error || theirs.error) throw mine.error || theirs.error;
      if (!mine.data || !theirs.data) return res.status(409).json({ error: 'Ambos deben estar buscando dupla' });
      const existing = await db.from('busca_dupla_invitacion').select('id,estado')
        .eq('torneo_id', tid).eq('from_user_id', user.id).eq('to_user_id', target).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) {
        if (existing.data.estado !== 'pendiente') {
          const reopened = await db.from('busca_dupla_invitacion').update({ estado: 'pendiente' })
            .eq('id', existing.data.id).select('id').maybeSingle();
          if (reopened.error) throw reopened.error;
        }
        return res.json({ ok: true, invitation_id: existing.data.id, existing: true });
      }
      const created = await db.from('busca_dupla_invitacion').insert({ torneo_id: tid, from_user_id: user.id, to_user_id: target, estado: 'pendiente' }).select('id').maybeSingle();
      if (created.error && String(created.error.code) !== '23505') throw created.error;
      return res.json({ ok: true, invitation_id: created.data?.id || null, existing: String(created.error?.code || '') === '23505' });
    } catch (error) { return partnerError(res, error); }
  });

  app.post('/api/torneos/:id/busca-dupla/invitaciones/:invId/rechazar', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id); const invId = validId(req.params.invId);
      if (!tid || !invId) return res.status(400).json({ error: 'ID inválido' });
      const found = await db.from('busca_dupla_invitacion').select('id,torneo_id,to_user_id,estado').eq('id', invId).maybeSingle();
      if (found.error) throw found.error;
      if (!found.data || Number(found.data.torneo_id) !== tid) return res.status(404).json({ error: 'Invitación no encontrada' });
      if (String(found.data.to_user_id) !== String(user.id)) return res.status(403).json({ error: 'Solo el invitado puede rechazar' });
      if (found.data.estado === 'pendiente') { const updated = await db.from('busca_dupla_invitacion').update({ estado: 'rechazada' }).eq('id', invId).eq('estado', 'pendiente'); if (updated.error) throw updated.error; }
      return res.json({ ok: true });
    } catch (error) { return partnerError(res, error); }
  });

  app.post('/api/torneos/:id/busca-dupla/invitaciones/:invId/aceptar', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id); const invId = validId(req.params.invId);
      if (!tid || !invId) return res.status(400).json({ error: 'ID inválido' });
      const found = await db.from('busca_dupla_invitacion').select('id,torneo_id,from_user_id,to_user_id,estado').eq('id', invId).maybeSingle();
      if (found.error) throw found.error; const invitation = found.data;
      if (!invitation || Number(invitation.torneo_id) !== tid) return res.status(404).json({ error: 'Invitación no encontrada' });
      if (String(invitation.to_user_id) !== String(user.id)) return res.status(403).json({ error: 'Solo el invitado puede aceptar' });
      if (invitation.estado !== 'pendiente') return res.status(409).json({ error: 'La invitación ya fue procesada' });
      const tournament = await db.from('torneos').select('id,nombre,estado,fecha_inicio').eq('id', tid).maybeSingle();
      if (tournament.error) throw tournament.error;
      if (!tournamentAllowsPartnerSearch(tournament.data, now())) return res.status(409).json({ error: 'El torneo no admite formar dupla ahora' });
      const fromId = String(invitation.from_user_id), toId = String(invitation.to_user_id);
      if (await hasTeam(db, tid, { id: fromId }) || await hasTeam(db, tid, user)) return res.status(409).json({ error: 'Uno de los jugadores ya tiene equipo' });
      const [fromProfile, toProfile] = await Promise.all([profile(db, fromId), profile(db, toId, user.email)]);
      const players = [
        { id: fromId, email: String(fromProfile?.email || ''), nombre: fullName(fromProfile), alias: String(fromProfile?.alias || ''), estado: 'confirmado', rol: 'creador' },
        { id: toId, email: String(user.email || toProfile?.email || ''), nombre: fullName(toProfile), alias: String(toProfile?.alias || ''), estado: 'confirmado', rol: '' },
      ];
      const claimed = await db.from('busca_dupla_invitacion').update({ estado: 'aceptada' }).eq('id', invId).eq('estado', 'pendiente').select('id').maybeSingle();
      if (claimed.error) throw claimed.error;
      if (!claimed.data) return res.status(409).json({ error: 'La invitación ya fue procesada' });
      try {
        const created = await db.from('equipos').insert({ nombre: `Dupla ${players[0].alias || players[0].nombre} · ${players[1].alias || players[1].nombre}`, tipo_equipo: 'cerrado', torneo_id: tid, creador_id: fromId, creador_email: players[0].email || null, jugadores: players, solicitudes: [], cupo_maximo: 2, equipo_abierto: false, puntos_totales: 0 }).select().maybeSingle();
        if (created.error) throw created.error;
        // El equipo ya creado es el efecto principal. La limpieza es
        // idempotente y no debe convertir un éxito en un 500 que invite a
        // repetir la creación del equipo.
        try {
          for (const uid of [fromId, toId]) {
            await db.from('busca_dupla_torneo').delete().eq('torneo_id', tid).eq('user_id', uid);
          }
          await cancelPending(db, tid, [fromId, toId]);
          await db.from('busca_dupla_invitacion').update({ estado: 'aceptada' }).eq('id', invId);
        } catch { /* limpieza reintentable; el equipo ya quedó creado */ }
        return res.json({ ok: true, equipo: created.data });
      } catch (error) {
        await db.from('busca_dupla_invitacion').update({ estado: 'pendiente' }).eq('id', invId).eq('estado', 'aceptada');
        throw error;
      }
    } catch (error) { return partnerError(res, error); }
  });

  app.post('/api/torneos/:id/busca-dupla/limpiar-si-dupla-formada', async (req, res) => {
    try {
      const user = await auth(req, res, getAuthenticatedUser); if (!user) return;
      const tid = validId(req.params.id), teamId = validId(req.body?.equipo_id);
      if (!tid || !teamId) return res.status(400).json({ error: 'IDs inválidos' });
      const found = await db.from('equipos').select('id,torneo_id,jugadores,cupo_maximo,creador_id').eq('id', teamId).maybeSingle();
      if (found.error) throw found.error;
      if (!found.data || Number(found.data.torneo_id) !== tid) return res.status(404).json({ error: 'Equipo no encontrado' });
      const ids = registeredPlayerIds(found.data);
      if (!ids.includes(String(user.id)) && String(found.data.creador_id) !== String(user.id)) return res.status(403).json({ error: 'No pertenecés a este equipo' });
      if (ids.length < Number(found.data.cupo_maximo || 2)) return res.json({ ok: true, skipped: true, reason: 'equipo_incompleto' });
      for (const uid of ids) { const removed = await db.from('busca_dupla_torneo').delete().eq('torneo_id', tid).eq('user_id', uid); if (removed.error) throw removed.error; }
      await cancelPending(db, tid, ids);
      return res.json({ ok: true, removed_user_ids: ids });
    } catch (error) { return partnerError(res, error); }
  });
}
