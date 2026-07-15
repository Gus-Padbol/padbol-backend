import express from 'express';
import { maskEmail } from '../lib/safeLog.js';
import {
  EQUIPO_JUGADOR_SELECT,
  EQUIPO_JUGADOR_SELECT_LEGACY,
  EQUIPO_USUARIO_SELECT,
  EQUIPO_USUARIO_SELECT_LEGACY,
  isMissingEquipoColumnError,
  mapEquipoJugadorDto,
  mapEquipoSummaryContactFields,
} from '../lib/dto/equiposDto.js';
import { sendHttpError } from '../lib/httpErrors.js';
import { createNotificacionIfAbsent } from '../utils/notificaciones.js';
import {
  DEPORTE_LIMITS,
  assertCanInviteSelf,
  buildEquipoDefinitivoDto,
  buildEquipoNotificacionDedupeKey,
  canCaptainInvite,
  canReopenMembership,
  computeInviteExpiresAt,
  countAcceptedMembers as countAcceptedFromList,
  evaluateAcceptCupo,
  evaluateInviteSlot,
  findConflictingAcceptedTeam,
  findIncompatiblePendingMemberships,
  findMembership,
  isMemberExpired,
  isTorneoOpenForTeams,
  mapBuscarJugadorPublico,
  normalizeEmail,
  normalizeVisibilidad,
  parseEquipoId,
} from '../lib/equiposInvitaciones.js';

async function resolvePlayerProfile({ email, userId }, supabaseAdmin) {
  const filters = [];
  if (userId) filters.push(`user_id.eq.${userId}`);
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);
  if (filters.length === 0) return null;

  const { data } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('nombre, apellido, apodo, email, user_id, foto_url, expo_push_token, nivel')
    .or(filters.join(','))
    .maybeSingle();

  return data;
}

async function notifyEquipoEvent(supabaseAdmin, {
  event,
  userId,
  titulo,
  mensaje,
  equipoId,
  memberId,
  link = null,
}) {
  if (!userId) return;
  const dedupe_key = buildEquipoNotificacionDedupeKey(event, {
    equipoId,
    memberId,
    userId,
  });
  try {
    await createNotificacionIfAbsent(supabaseAdmin, {
      user_id: userId,
      tipo: event,
      titulo,
      mensaje,
      link: link ?? `padbolmatch://equipo/${equipoId}`,
      data: {
        dedupe_key,
        tipo: event,
        equipo_id: String(equipoId),
        member_id: memberId != null ? String(memberId) : null,
        navegacion: { screen: 'Equipo', params: { id: equipoId } },
      },
    });
  } catch (err) {
    console.warn(`⚠️ notif equipo ${event}:`, err.message);
  }
}

async function sendTeamInvitationPush({
  supabaseAdmin,
  equipo,
  capitanNombre,
  inviteeEmail,
  inviteeUserId,
  memberId = null,
}) {
  const perfil = await resolvePlayerProfile(
    { email: inviteeEmail, userId: inviteeUserId },
    supabaseAdmin,
  );

  console.log(
    `[EMAIL] Invitación equipo id=${equipo.id} (${equipo.deporte}) → ${maskEmail(inviteeEmail)}`,
  );

  if (perfil?.user_id) {
    await notifyEquipoEvent(supabaseAdmin, {
      event: 'invitacion_equipo_recibida',
      userId: perfil.user_id,
      titulo: 'Invitación a equipo',
      mensaje: `${capitanNombre} te invitó a unirte a ${equipo.nombre}`,
      equipoId: equipo.id,
      memberId,
    });
  }

  if (perfil?.expo_push_token) {
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: perfil.expo_push_token,
          title: 'Invitación a equipo',
          body: `${capitanNombre} te invitó a unirte a ${equipo.nombre}`,
          data: { type: 'invitacion_equipo', equipo_id: String(equipo.id) },
          sound: 'default',
        }),
      });
    } catch (error) {
      console.warn('⚠️ Push invitación equipo falló:', error.message);
    }
  }
}

async function selectEquipoUsuario(supabaseAdmin, apply) {
  let q = apply(supabaseAdmin.from('equipos_usuario').select(EQUIPO_USUARIO_SELECT));
  let result = await q;
  if (result.error && isMissingEquipoColumnError(result.error, 'visibilidad')) {
    q = apply(supabaseAdmin.from('equipos_usuario').select(EQUIPO_USUARIO_SELECT_LEGACY));
    result = await q;
  }
  return result;
}

function normalizeEquipoJugadorRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    tipo: row.tipo ?? 'invitacion',
    expires_at: row.expires_at ?? null,
  };
}

async function selectEquipoJugadores(supabaseAdmin, apply) {
  let q = apply(supabaseAdmin.from('equipos_jugadores').select(EQUIPO_JUGADOR_SELECT));
  let result = await q;
  if (
    result.error
    && (isMissingEquipoColumnError(result.error, 'tipo')
      || isMissingEquipoColumnError(result.error, 'expires_at'))
  ) {
    q = apply(supabaseAdmin.from('equipos_jugadores').select(EQUIPO_JUGADOR_SELECT_LEGACY));
    result = await q;
  }
  if (!result.error && result.data != null) {
    result.data = Array.isArray(result.data)
      ? result.data.map(normalizeEquipoJugadorRow)
      : normalizeEquipoJugadorRow(result.data);
  }
  return result;
}

async function countAcceptedMembers(equipoId, supabaseAdmin) {
  const { count, error } = await supabaseAdmin
    .from('equipos_jugadores')
    .select('*', { count: 'exact', head: true })
    .eq('equipo_id', equipoId)
    .eq('estado', 'aceptado');
  if (error) throw error;
  return count ?? 0;
}

async function refreshEquipoEstado(equipo, supabaseAdmin) {
  if (equipo.torneo_id) return 'inscripto';
  const accepted = await countAcceptedMembers(equipo.id, supabaseAdmin);
  if (accepted >= equipo.min_jugadores) return 'completo';
  return 'formando';
}

async function expirePendingIfNeeded(members, supabaseAdmin) {
  const now = new Date();
  const expired = members.filter((m) => isMemberExpired(m, now));
  if (!expired.length) return members;
  const ids = expired.map((m) => m.id);
  await supabaseAdmin
    .from('equipos_jugadores')
    .update({ estado: 'vencido', responded_at: now.toISOString() })
    .in('id', ids)
    .eq('estado', 'pendiente');
  return members.map((m) => (ids.includes(m.id) ? { ...m, estado: 'vencido' } : m));
}

async function getEquipoBundle(equipoId, supabaseAdmin) {
  const { data: equipo, error } = await selectEquipoUsuario(supabaseAdmin, (q) =>
    q.eq('id', equipoId).maybeSingle());
  if (error) throw error;
  if (!equipo) return null;

  const { data: members, error: membersErr } = await selectEquipoJugadores(supabaseAdmin, (q) =>
    q.eq('equipo_id', equipoId).order('invited_at', { ascending: true }));
  if (membersErr) throw membersErr;

  const normalized = await expirePendingIfNeeded(members ?? [], supabaseAdmin);
  return {
    equipo: {
      ...equipo,
      visibilidad: normalizeVisibilidad(equipo.visibilidad, 'cerrado'),
    },
    members: normalized,
  };
}

async function mapEquipoSummary(equipo, members, supabaseAdmin, user = null) {
  const capitanPerfil = await resolvePlayerProfile(
    { userId: equipo.capitan_user_id, email: equipo.capitan_email },
    supabaseAdmin,
  );
  const accepted = countAcceptedFromList(members);
  const pending = members.filter((m) => m.estado === 'pendiente').length;
  const estado = equipo.torneo_id
    ? 'inscripto'
    : (accepted >= equipo.min_jugadores ? 'completo' : 'formando');
  const myMembership = findMembership(members, user);
  const contact = mapEquipoSummaryContactFields(equipo, user);

  return {
    id: equipo.id,
    nombre: equipo.nombre,
    deporte: equipo.deporte,
    deporte_label: DEPORTE_LIMITS[equipo.deporte]?.label ?? equipo.deporte,
    estado,
    visibilidad: normalizeVisibilidad(equipo.visibilidad, 'cerrado'),
    min_jugadores: equipo.min_jugadores,
    max_jugadores: equipo.max_jugadores,
    miembros_total: members.length,
    miembros_aceptados: accepted,
    miembros_pendientes: pending,
    capitan_user_id: contact.capitan_user_id,
    capitan_nombre: capitanPerfil?.nombre ?? (contact.es_capitan ? equipo.capitan_email : null) ?? 'Capitán',
    capitan_email: contact.capitan_email,
    torneo_id: equipo.torneo_id ?? null,
    es_capitan: contact.es_capitan,
    mi_estado: myMembership?.estado ?? null,
    created_at: equipo.created_at,
  };
}

async function mapEquipoDetail(bundle, supabaseAdmin, user) {
  const isCaptain = Boolean(user && bundle.equipo.capitan_user_id === user.id);
  const enrichedMembers = await Promise.all(
    bundle.members.map(async (member) => {
      const perfil = await resolvePlayerProfile(
        { email: member.email, userId: member.user_id },
        supabaseAdmin,
      );
      return mapEquipoJugadorDto(member, perfil, { viewer: user, isCaptain });
    }),
  );

  const summary = await mapEquipoSummary(bundle.equipo, bundle.members, supabaseAdmin, user);
  const definitivo = buildEquipoDefinitivoDto({
    summary,
    members: enrichedMembers,
    viewer: user,
  });

  return {
    ...definitivo,
    jugadores: enrichedMembers,
  };
}

async function findAcceptedConflict(supabaseAdmin, { userId, email, torneoId, currentEquipoId }) {
  if (torneoId == null) return null;

  const { data: teams, error } = await selectEquipoUsuario(supabaseAdmin, (q) =>
    q.eq('torneo_id', torneoId));
  if (error) throw error;
  const otherIds = (teams ?? [])
    .map((t) => t.id)
    .filter((id) => Number(id) !== Number(currentEquipoId));
  if (!otherIds.length) return null;

  const { data: members, error: mErr } = await selectEquipoJugadores(supabaseAdmin, (q) =>
    q.in('equipo_id', otherIds).eq('estado', 'aceptado'));
  if (mErr) throw mErr;

  const withTorneo = (members ?? []).map((m) => ({ ...m, torneo_id: torneoId }));
  return findConflictingAcceptedTeam({
    acceptedInOtherTeams: withTorneo,
    userId,
    email,
    torneoId,
    currentEquipoId,
  });
}

async function cancelIncompatiblePendings(supabaseAdmin, {
  userId,
  email,
  torneoId,
  currentEquipoId,
}) {
  if (torneoId == null) return;
  const { data: teams, error } = await selectEquipoUsuario(supabaseAdmin, (q) =>
    q.eq('torneo_id', torneoId));
  if (error) throw error;
  const otherIds = (teams ?? [])
    .map((t) => t.id)
    .filter((id) => Number(id) !== Number(currentEquipoId));
  if (!otherIds.length) return;

  const { data: pending, error: pErr } = await selectEquipoJugadores(supabaseAdmin, (q) =>
    q.in('equipo_id', otherIds).eq('estado', 'pendiente'));
  if (pErr) throw pErr;

  const rows = (pending ?? []).map((m) => ({ ...m, torneo_id: torneoId }));
  const incompat = findIncompatiblePendingMemberships({
    allMemberships: rows,
    acceptedUserId: userId,
    acceptedEmail: email,
    torneoId,
    currentEquipoId,
  });
  if (!incompat.length) return;
  await supabaseAdmin
    .from('equipos_jugadores')
    .update({ estado: 'cancelado', responded_at: new Date().toISOString() })
    .in('id', incompat.map((r) => r.id))
    .eq('estado', 'pendiente');
}

function buildMemberInsertPayload({
  equipoId,
  email,
  userId = null,
  nombre = null,
  tipo = 'invitacion',
  estado = 'pendiente',
  rol = 'jugador',
  now = new Date().toISOString(),
}) {
  const payload = {
    equipo_id: equipoId,
    email: normalizeEmail(email),
    user_id: userId,
    nombre,
    rol,
    estado,
    invited_at: now,
  };
  if (estado === 'pendiente') {
    payload.expires_at = computeInviteExpiresAt(new Date());
  }
  if (tipo) payload.tipo = tipo;
  return payload;
}

async function insertOrReopenMember(supabaseAdmin, payload, existing) {
  if (!existing) {
    const { data, error } = await supabaseAdmin
      .from('equipos_jugadores')
      .insert([payload])
      .select(EQUIPO_JUGADOR_SELECT_LEGACY)
      .maybeSingle();
    if (error) {
      // retry without optional cols
      if (isMissingEquipoColumnError(error, 'tipo') || isMissingEquipoColumnError(error, 'expires_at')) {
        const legacy = { ...payload };
        delete legacy.tipo;
        delete legacy.expires_at;
        const retry = await supabaseAdmin.from('equipos_jugadores').insert([legacy]).select('*').maybeSingle();
        if (retry.error) throw retry.error;
        return retry.data;
      }
      throw error;
    }
    return data;
  }

  if (!canReopenMembership(existing)) {
    const err = new Error(
      existing.estado === 'pendiente'
        ? 'Ya hay una invitación o solicitud pendiente'
        : 'El jugador ya es integrante del equipo',
    );
    err.status = existing.estado === 'pendiente' ? 409 : 409;
    throw err;
  }

  const patch = {
    estado: 'pendiente',
    tipo: payload.tipo ?? 'invitacion',
    user_id: payload.user_id ?? existing.user_id,
    nombre: payload.nombre ?? existing.nombre,
    invited_at: payload.invited_at,
    responded_at: null,
    expires_at: payload.expires_at ?? computeInviteExpiresAt(new Date()),
  };

  const { data, error } = await supabaseAdmin
    .from('equipos_jugadores')
    .update(patch)
    .eq('id', existing.id)
    .select('*')
    .maybeSingle();
  if (error) {
    if (isMissingEquipoColumnError(error, 'tipo') || isMissingEquipoColumnError(error, 'expires_at')) {
      const legacyPatch = { ...patch };
      delete legacyPatch.tipo;
      delete legacyPatch.expires_at;
      const retry = await supabaseAdmin
        .from('equipos_jugadores')
        .update(legacyPatch)
        .eq('id', existing.id)
        .select('*')
        .maybeSingle();
      if (retry.error) throw retry.error;
      return retry.data;
    }
    throw error;
  }
  return data;
}

export function createEquiposUsuarioRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/buscar-jugador', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const query = String(req.query.query ?? req.query.q ?? '').trim();
      if (query.length < 2) return res.json([]);

      const escaped = query.replace(/"/g, '\\"');
      const { data, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .select('nombre, apellido, apodo, user_id, foto_url, nivel, email')
        .or(`nombre.ilike."%${escaped}%",apellido.ilike."%${escaped}%",apodo.ilike."%${escaped}%"`)
        .limit(10);

      if (error) throw error;

      res.json(
        (data ?? [])
          .filter((row) => row.user_id !== user.id)
          .map((row) => mapBuscarJugadorPublico(row))
          .filter(Boolean),
      );
    } catch (err) {
      console.error('❌ Error GET /api/equipos/buscar-jugador:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/mis-equipos', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const memberFilters = [`user_id.eq.${user.id}`];
      if (user.email) {
        memberFilters.push(`email.eq."${String(user.email).replace(/"/g, '\\"')}"`);
      }

      const [{ data: capitanEquipos, error: capitanErr }, { data: memberRows, error: memberErr }] =
        await Promise.all([
          selectEquipoUsuario(supabaseAdmin, (q) => q.eq('capitan_user_id', user.id)),
          supabaseAdmin
            .from('equipos_jugadores')
            .select('equipo_id')
            .or(memberFilters.join(',')),
        ]);

      if (capitanErr) throw capitanErr;
      if (memberErr) throw memberErr;

      const memberEquipoIds = [...new Set((memberRows ?? []).map((row) => row.equipo_id))];
      let memberEquipos = [];
      if (memberEquipoIds.length > 0) {
        const { data, error } = await selectEquipoUsuario(supabaseAdmin, (q) =>
          q.in('id', memberEquipoIds));
        if (error) throw error;
        memberEquipos = data ?? [];
      }

      const byId = new Map();
      [...(capitanEquipos ?? []), ...memberEquipos].forEach((equipo) => {
        byId.set(equipo.id, equipo);
      });

      const result = await Promise.all(
        [...byId.values()].map(async (equipo) => {
          const bundle = await getEquipoBundle(equipo.id, supabaseAdmin);
          return mapEquipoSummary(bundle.equipo, bundle.members, supabaseAdmin, user);
        }),
      );

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/equipos/mis-equipos:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/invitaciones-recibidas', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const filters = [`user_id.eq.${user.id}`];
      if (user.email) filters.push(`email.eq."${String(user.email).replace(/"/g, '\\"')}"`);

      const { data: rows, error } = await selectEquipoJugadores(supabaseAdmin, (q) =>
        q.or(filters.join(',')).eq('estado', 'pendiente').eq('tipo', 'invitacion'));
      // tipo may be missing
      let pending = rows;
      if (error && isMissingEquipoColumnError(error, 'tipo')) {
        const legacy = await selectEquipoJugadores(supabaseAdmin, (q) =>
          q.or(filters.join(',')).eq('estado', 'pendiente'));
        if (legacy.error) throw legacy.error;
        pending = legacy.data;
      } else if (error) {
        throw error;
      }

      pending = await expirePendingIfNeeded(pending ?? [], supabaseAdmin);
      pending = pending.filter((m) => m.estado === 'pendiente' && (m.tipo ?? 'invitacion') === 'invitacion');

      const equipos = [];
      for (const member of pending) {
        const bundle = await getEquipoBundle(member.equipo_id, supabaseAdmin);
        if (!bundle) continue;
        equipos.push({
          invitacion_id: member.id,
          equipo: await mapEquipoSummary(bundle.equipo, bundle.members, supabaseAdmin, user),
          expires_at: member.expires_at ?? null,
        });
      }
      res.json({ invitaciones: equipos });
    } catch (err) {
      console.error('❌ Error GET /api/equipos/invitaciones-recibidas:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const nombre = String(req.body?.nombre ?? '').trim();
      const deporte = String(req.body?.deporte ?? '').trim().toLowerCase();
      const limits = DEPORTE_LIMITS[deporte];
      const inviteEmails = Array.isArray(req.body?.jugadores_emails)
        ? req.body.jugadores_emails.map(normalizeEmail).filter(Boolean)
        : [];
      const visibilidad = normalizeVisibilidad(req.body?.visibilidad, 'cerrado');

      if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
      if (!limits) return res.status(400).json({ error: 'deporte inválido' });

      const uniqueEmails = [...new Set(inviteEmails)]
        .filter((email) => email !== normalizeEmail(user.email));

      if (uniqueEmails.length + 1 > limits.max) {
        return res.status(400).json({ error: `Máximo ${limits.max} jugadores para ${limits.label}` });
      }

      const capitanPerfil = await resolvePlayerProfile({ userId: user.id, email: user.email }, supabaseAdmin);
      const now = new Date().toISOString();

      const insertPayload = {
        nombre,
        deporte,
        capitan_user_id: user.id,
        capitan_email: user.email ?? null,
        min_jugadores: limits.min,
        max_jugadores: limits.max,
        estado: 'formando',
        visibilidad,
        updated_at: now,
      };

      let { data: equipo, error: insertErr } = await supabaseAdmin
        .from('equipos_usuario')
        .insert([insertPayload])
        .select(EQUIPO_USUARIO_SELECT_LEGACY)
        .single();

      if (insertErr && isMissingEquipoColumnError(insertErr, 'visibilidad')) {
        delete insertPayload.visibilidad;
        const retry = await supabaseAdmin
          .from('equipos_usuario')
          .insert([insertPayload])
          .select(EQUIPO_USUARIO_SELECT_LEGACY)
          .single();
        if (retry.error) throw retry.error;
        equipo = retry.data;
      } else if (insertErr) {
        throw insertErr;
      }

      const memberRows = [
        {
          equipo_id: equipo.id,
          user_id: user.id,
          email: normalizeEmail(user.email),
          nombre: capitanPerfil?.nombre ?? user.email,
          rol: 'capitan',
          estado: 'aceptado',
          tipo: 'invitacion',
          invited_at: now,
          responded_at: now,
        },
        ...uniqueEmails.map((email) => buildMemberInsertPayload({
          equipoId: equipo.id,
          email,
          now,
        })),
      ];

      const { error: membersErr } = await supabaseAdmin.from('equipos_jugadores').insert(memberRows);
      if (membersErr && (isMissingEquipoColumnError(membersErr, 'tipo') || isMissingEquipoColumnError(membersErr, 'expires_at'))) {
        const legacyRows = memberRows.map((r) => {
          const copy = { ...r };
          delete copy.tipo;
          delete copy.expires_at;
          return copy;
        });
        const retry = await supabaseAdmin.from('equipos_jugadores').insert(legacyRows);
        if (retry.error) throw retry.error;
      } else if (membersErr) {
        throw membersErr;
      }

      await Promise.all(
        uniqueEmails.map((email) =>
          sendTeamInvitationPush({
            supabaseAdmin,
            equipo,
            capitanNombre: capitanPerfil?.nombre ?? user.email ?? 'Capitán',
            inviteeEmail: email,
          }),
        ),
      );

      const bundle = await getEquipoBundle(equipo.id, supabaseAdmin);
      res.status(201).json(await mapEquipoDetail(bundle, supabaseAdmin, user));
    } catch (err) {
      console.error('❌ Error POST /api/equipos:', err.message);
      return sendHttpError(res, err);
    }
  });

  // Cancel invitation by member id
  router.post('/invitaciones/:memberId/cancelar', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const memberId = parseEquipoId(req.params.memberId);
      if (memberId == null) return res.status(400).json({ error: 'ID inválido' });

      const { data: member, error } = await selectEquipoJugadores(supabaseAdmin, (q) =>
        q.eq('id', memberId).maybeSingle());
      if (error) throw error;
      if (!member) return res.status(404).json({ error: 'Invitación no encontrada' });

      const bundle = await getEquipoBundle(member.equipo_id, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });
      if (!canCaptainInvite(bundle.equipo, user)) {
        return res.status(403).json({ error: 'Solo el capitán puede cancelar invitaciones' });
      }
      if (member.estado !== 'pendiente') {
        return res.status(400).json({ error: 'Solo se pueden cancelar invitaciones pendientes' });
      }

      await supabaseAdmin
        .from('equipos_jugadores')
        .update({ estado: 'cancelado', responded_at: new Date().toISOString() })
        .eq('id', memberId)
        .eq('estado', 'pendiente');

      if (member.user_id) {
        await notifyEquipoEvent(supabaseAdmin, {
          event: 'invitacion_equipo_cancelada',
          userId: member.user_id,
          titulo: 'Invitación cancelada',
          mensaje: `Tu invitación a ${bundle.equipo.nombre} fue cancelada`,
          equipoId: bundle.equipo.id,
          memberId,
        });
      }

      const updated = await getEquipoBundle(bundle.equipo.id, supabaseAdmin);
      res.json({ success: true, equipo: await mapEquipoDetail(updated, supabaseAdmin, user) });
    } catch (err) {
      console.error('❌ Error POST /api/equipos/invitaciones/:id/cancelar:', err.message);
      return sendHttpError(res, err);
    }
  });

  async function respondSolicitud(req, res, nextEstado) {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const memberId = parseEquipoId(req.params.memberId);
      if (memberId == null) return res.status(400).json({ error: 'ID inválido' });

      const { data: member, error } = await selectEquipoJugadores(supabaseAdmin, (q) =>
        q.eq('id', memberId).maybeSingle());
      if (error) throw error;
      if (!member) return res.status(404).json({ error: 'Solicitud no encontrada' });
      if ((member.tipo ?? 'invitacion') !== 'solicitud') {
        return res.status(400).json({ error: 'No es una solicitud de ingreso' });
      }

      const bundle = await getEquipoBundle(member.equipo_id, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });
      if (!canCaptainInvite(bundle.equipo, user)) {
        return res.status(403).json({ error: 'Solo el capitán puede gestionar solicitudes' });
      }
      if (member.estado !== 'pendiente') {
        return res.status(400).json({ error: 'La solicitud ya fue respondida' });
      }

      if (nextEstado === 'aceptado') {
        const cupoErr = evaluateAcceptCupo({
          members: bundle.members,
          maxJugadores: bundle.equipo.max_jugadores,
          membershipId: member.id,
        });
        if (cupoErr) return res.status(cupoErr.status).json({ error: cupoErr.message });

        const conflict = await findAcceptedConflict(supabaseAdmin, {
          userId: member.user_id,
          email: member.email,
          torneoId: bundle.equipo.torneo_id,
          currentEquipoId: bundle.equipo.id,
        });
        if (conflict) {
          return res.status(409).json({ error: 'El jugador ya está en otro equipo de este torneo' });
        }
      }

      const now = new Date().toISOString();
      await supabaseAdmin
        .from('equipos_jugadores')
        .update({ estado: nextEstado, responded_at: now })
        .eq('id', member.id)
        .eq('estado', 'pendiente');

      if (nextEstado === 'aceptado') {
        await cancelIncompatiblePendings(supabaseAdmin, {
          userId: member.user_id,
          email: member.email,
          torneoId: bundle.equipo.torneo_id,
          currentEquipoId: bundle.equipo.id,
        });
      }

      const newEstado = await refreshEquipoEstado(bundle.equipo, supabaseAdmin);
      await supabaseAdmin
        .from('equipos_usuario')
        .update({ estado: newEstado, updated_at: now })
        .eq('id', bundle.equipo.id);

      if (member.user_id) {
        await notifyEquipoEvent(supabaseAdmin, {
          event: nextEstado === 'aceptado' ? 'solicitud_equipo_aceptada' : 'solicitud_equipo_rechazada',
          userId: member.user_id,
          titulo: nextEstado === 'aceptado' ? 'Solicitud aceptada' : 'Solicitud rechazada',
          mensaje: nextEstado === 'aceptado'
            ? `Te aceptaron en ${bundle.equipo.nombre}`
            : `Tu solicitud a ${bundle.equipo.nombre} fue rechazada`,
          equipoId: bundle.equipo.id,
          memberId: member.id,
        });
      }

      const updated = await getEquipoBundle(bundle.equipo.id, supabaseAdmin);
      res.json({
        success: true,
        estado: nextEstado,
        equipo: await mapEquipoDetail(updated, supabaseAdmin, user),
      });
    } catch (err) {
      console.error(`❌ Error solicitud ${nextEstado}:`, err.message);
      return sendHttpError(res, err);
    }
  }

  router.post('/solicitudes/:memberId/aceptar', (req, res) => respondSolicitud(req, res, 'aceptado'));
  router.post('/solicitudes/:memberId/rechazar', (req, res) => respondSolicitud(req, res, 'rechazado'));

  // Alias por membership id (además de POST /:equipoId/aceptar|rechazar legacy)
  async function respondInvitationByMemberId(req, res, nextEstado) {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const memberId = parseEquipoId(req.params.memberId);
      if (memberId == null) return res.status(400).json({ error: 'ID inválido' });

      const { data: member, error } = await selectEquipoJugadores(supabaseAdmin, (q) =>
        q.eq('id', memberId).maybeSingle());
      if (error) throw error;
      if (!member) return res.status(404).json({ error: 'Invitación no encontrada' });

      req.params.id = String(member.equipo_id);
      return respondInvitation(req, res, nextEstado);
    } catch (err) {
      console.error(`❌ Error invitaciones/:id/${nextEstado}:`, err.message);
      return sendHttpError(res, err);
    }
  }

  router.post('/invitaciones/:memberId/aceptar', (req, res) =>
    respondInvitationByMemberId(req, res, 'aceptado'));
  router.post('/invitaciones/:memberId/rechazar', (req, res) =>
    respondInvitationByMemberId(req, res, 'rechazado'));

  router.get('/:id', async (req, res) => {
    try {
      const { user } = await getAuthenticatedUser(req);
      const equipoId = parseEquipoId(req.params.id);
      if (equipoId == null) return res.status(400).json({ error: 'ID de equipo inválido' });

      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });

      res.json(await mapEquipoDetail(bundle, supabaseAdmin, user));
    } catch (err) {
      console.error('❌ Error GET /api/equipos/:id:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.get('/:id/invitaciones', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const equipoId = parseEquipoId(req.params.id);
      if (equipoId == null) return res.status(400).json({ error: 'ID de equipo inválido' });
      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });
      if (!canCaptainInvite(bundle.equipo, user)) {
        return res.status(403).json({ error: 'Solo el capitán puede ver invitaciones enviadas' });
      }

      const invitaciones = bundle.members
        .filter((m) => (m.tipo ?? 'invitacion') === 'invitacion')
        .map((m) => mapEquipoJugadorDto(m, null, { viewer: user, isCaptain: true }));

      res.json({ invitaciones });
    } catch (err) {
      return sendHttpError(res, err);
    }
  });

  async function respondInvitation(req, res, nextEstado) {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const equipoId = parseEquipoId(req.params.id);
      if (equipoId == null) return res.status(400).json({ error: 'ID de equipo inválido' });

      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });

      const membership = findMembership(bundle.members, user);
      if (!membership) {
        return res.status(404).json({ error: 'No tenés invitación para este equipo' });
      }
      if ((membership.tipo ?? 'invitacion') !== 'invitacion') {
        return res.status(400).json({ error: 'No es una invitación' });
      }
      if (membership.estado === nextEstado) {
        const updatedBundle = await getEquipoBundle(equipoId, supabaseAdmin);
        return res.json({
          success: true,
          estado: nextEstado,
          idempotent: true,
          equipo: await mapEquipoDetail(updatedBundle, supabaseAdmin, user),
        });
      }
      if (membership.estado !== 'pendiente') {
        return res.status(400).json({ error: 'La invitación ya fue respondida' });
      }
      if (isMemberExpired(membership)) {
        await supabaseAdmin
          .from('equipos_jugadores')
          .update({ estado: 'vencido', responded_at: new Date().toISOString() })
          .eq('id', membership.id);
        return res.status(410).json({ error: 'La invitación está vencida' });
      }

      if (nextEstado === 'aceptado') {
        const cupoErr = evaluateAcceptCupo({
          members: bundle.members,
          maxJugadores: bundle.equipo.max_jugadores,
          membershipId: membership.id,
        });
        if (cupoErr) return res.status(cupoErr.status).json({ error: cupoErr.message });

        const conflict = await findAcceptedConflict(supabaseAdmin, {
          userId: user.id,
          email: user.email,
          torneoId: bundle.equipo.torneo_id,
          currentEquipoId: equipoId,
        });
        if (conflict) {
          return res.status(409).json({ error: 'Ya estás en otro equipo de este torneo' });
        }
      }

      const perfil = await resolvePlayerProfile({ userId: user.id, email: user.email }, supabaseAdmin);
      const now = new Date().toISOString();

      const { error: updateErr } = await supabaseAdmin
        .from('equipos_jugadores')
        .update({
          estado: nextEstado,
          user_id: user.id,
          nombre: perfil?.nombre ?? user.email,
          responded_at: now,
        })
        .eq('id', membership.id)
        .eq('estado', 'pendiente');

      if (updateErr) throw updateErr;

      if (nextEstado === 'aceptado') {
        await cancelIncompatiblePendings(supabaseAdmin, {
          userId: user.id,
          email: user.email,
          torneoId: bundle.equipo.torneo_id,
          currentEquipoId: equipoId,
        });
      }

      const newEstado = await refreshEquipoEstado(bundle.equipo, supabaseAdmin);
      await supabaseAdmin
        .from('equipos_usuario')
        .update({ estado: newEstado, updated_at: now })
        .eq('id', equipoId);

      if (bundle.equipo.capitan_user_id) {
        await notifyEquipoEvent(supabaseAdmin, {
          event: nextEstado === 'aceptado' ? 'invitacion_equipo_aceptada' : 'invitacion_equipo_rechazada',
          userId: bundle.equipo.capitan_user_id,
          titulo: nextEstado === 'aceptado' ? 'Invitación aceptada' : 'Invitación rechazada',
          mensaje: nextEstado === 'aceptado'
            ? `${perfil?.nombre ?? user.email} aceptó unirse a ${bundle.equipo.nombre}`
            : `${perfil?.nombre ?? user.email} rechazó la invitación a ${bundle.equipo.nombre}`,
          equipoId,
          memberId: membership.id,
        });
      }

      const updatedBundle = await getEquipoBundle(equipoId, supabaseAdmin);
      res.json({
        success: true,
        estado: nextEstado,
        equipo: await mapEquipoDetail(updatedBundle, supabaseAdmin, user),
      });
    } catch (err) {
      console.error(`❌ Error POST /api/equipos/:id/${nextEstado}:`, err.message);
      return sendHttpError(res, err);
    }
  }

  router.post('/:id/aceptar', (req, res) => respondInvitation(req, res, 'aceptado'));
  router.post('/:id/rechazar', (req, res) => respondInvitation(req, res, 'rechazado'));

  async function inviteToEquipo(req, res) {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const equipoId = parseEquipoId(req.params.id);
      if (equipoId == null) return res.status(400).json({ error: 'ID de equipo inválido' });

      const emails = Array.isArray(req.body?.jugadores_emails)
        ? req.body.jugadores_emails.map(normalizeEmail).filter(Boolean)
        : req.body?.email
          ? [normalizeEmail(req.body.email)]
          : [];
      const userIds = Array.isArray(req.body?.user_ids)
        ? req.body.user_ids.map((id) => String(id).trim()).filter(Boolean)
        : req.body?.user_id
          ? [String(req.body.user_id).trim()]
          : [];

      if (emails.length === 0 && userIds.length === 0) {
        return res.status(400).json({ error: 'Se requiere al menos un email o user_id' });
      }

      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });
      if (!canCaptainInvite(bundle.equipo, user)) {
        return res.status(403).json({ error: 'Solo el capitán puede invitar jugadores' });
      }
      if (bundle.equipo.torneo_id || bundle.equipo.estado === 'inscripto') {
        return res.status(409).json({ error: 'El equipo ya no admite invitaciones' });
      }

      const targets = [];
      for (const email of emails) {
        targets.push({ email, userId: null });
      }
      for (const uid of userIds) {
        const perfil = await resolvePlayerProfile({ userId: uid }, supabaseAdmin);
        if (!perfil?.email) {
          return res.status(404).json({ error: `Jugador no encontrado: ${uid}` });
        }
        targets.push({ email: normalizeEmail(perfil.email), userId: uid, nombre: perfil.nombre });
      }

      const uniqueTargets = [];
      const seen = new Set();
      for (const t of targets) {
        const key = normalizeEmail(t.email);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueTargets.push(t);
      }

      const slotErr = evaluateInviteSlot({
        members: bundle.members,
        maxJugadores: bundle.equipo.max_jugadores,
        adding: uniqueTargets.length,
      });
      if (slotErr) return res.status(slotErr.status).json({ error: slotErr.message });

      const capitanPerfil = await resolvePlayerProfile(
        { userId: user.id, email: user.email },
        supabaseAdmin,
      );
      const now = new Date().toISOString();

      for (const target of uniqueTargets) {
        const selfErr = assertCanInviteSelf({
          captainUserId: user.id,
          inviteeUserId: target.userId,
          inviteeEmail: target.email,
          captainEmail: user.email,
        });
        if (selfErr) return res.status(selfErr.status).json({ error: selfErr.message });

        const conflict = await findAcceptedConflict(supabaseAdmin, {
          userId: target.userId,
          email: target.email,
          torneoId: bundle.equipo.torneo_id,
          currentEquipoId: equipoId,
        });
        if (conflict) {
          return res.status(409).json({ error: `El jugador ${target.email} ya está en otro equipo del torneo` });
        }

        const existing = bundle.members.find((m) => normalizeEmail(m.email) === target.email);
        const payload = buildMemberInsertPayload({
          equipoId,
          email: target.email,
          userId: target.userId,
          nombre: target.nombre ?? null,
          tipo: 'invitacion',
          now,
        });

        try {
          const saved = await insertOrReopenMember(supabaseAdmin, payload, existing);
          if (saved) {
            existing
              ? Object.assign(existing, saved)
              : bundle.members.push(saved);
          }
          await sendTeamInvitationPush({
            supabaseAdmin,
            equipo: bundle.equipo,
            capitanNombre: capitanPerfil?.nombre ?? user.email ?? 'Capitán',
            inviteeEmail: target.email,
            inviteeUserId: target.userId ?? saved?.user_id,
            memberId: saved?.id ?? null,
          });
        } catch (inviteErr) {
          return res.status(inviteErr.status || 500).json({ error: inviteErr.message });
        }
      }

      const updatedBundle = await getEquipoBundle(equipoId, supabaseAdmin);
      res.json(await mapEquipoDetail(updatedBundle, supabaseAdmin, user));
    } catch (err) {
      console.error('❌ Error POST /api/equipos/:id/invitar:', err.message);
      return sendHttpError(res, err);
    }
  }

  router.post('/:id/invitar', inviteToEquipo);
  router.post('/:id/invitaciones', inviteToEquipo);

  router.post('/:id/solicitudes', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const equipoId = parseEquipoId(req.params.id);
      if (equipoId == null) return res.status(400).json({ error: 'ID de equipo inválido' });

      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });

      if (normalizeVisibilidad(bundle.equipo.visibilidad, 'cerrado') !== 'abierto') {
        return res.status(403).json({ error: 'Este equipo no admite solicitudes de ingreso' });
      }
      if (bundle.equipo.torneo_id || bundle.equipo.estado === 'inscripto') {
        return res.status(409).json({ error: 'El equipo ya no admite jugadores' });
      }
      if (canCaptainInvite(bundle.equipo, user)) {
        return res.status(400).json({ error: 'El capitán no puede solicitar ingreso a su propio equipo' });
      }

      const slotErr = evaluateInviteSlot({
        members: bundle.members,
        maxJugadores: bundle.equipo.max_jugadores,
        adding: 1,
      });
      if (slotErr) return res.status(slotErr.status).json({ error: slotErr.message });

      const conflict = await findAcceptedConflict(supabaseAdmin, {
        userId: user.id,
        email: user.email,
        torneoId: bundle.equipo.torneo_id,
        currentEquipoId: equipoId,
      });
      if (conflict) {
        return res.status(409).json({ error: 'Ya estás en otro equipo de este torneo' });
      }

      const perfil = await resolvePlayerProfile({ userId: user.id, email: user.email }, supabaseAdmin);
      const existing = findMembership(bundle.members, user);
      const payload = buildMemberInsertPayload({
        equipoId,
        email: user.email,
        userId: user.id,
        nombre: perfil?.nombre ?? user.email,
        tipo: 'solicitud',
      });

      let member;
      try {
        member = await insertOrReopenMember(supabaseAdmin, payload, existing);
      } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
      }

      await notifyEquipoEvent(supabaseAdmin, {
        event: 'solicitud_equipo_recibida',
        userId: bundle.equipo.capitan_user_id,
        titulo: 'Nueva solicitud de ingreso',
        mensaje: `${perfil?.nombre ?? user.email} quiere unirse a ${bundle.equipo.nombre}`,
        equipoId,
        memberId: member?.id,
      });

      const updated = await getEquipoBundle(equipoId, supabaseAdmin);
      res.status(201).json({
        success: true,
        solicitud_id: member?.id ?? null,
        equipo: await mapEquipoDetail(updated, supabaseAdmin, user),
      });
    } catch (err) {
      console.error('❌ Error POST /api/equipos/:id/solicitudes:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.delete('/:id/jugadores/:jugadorId', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const equipoId = parseEquipoId(req.params.id);
      const jugadorId = parseEquipoId(req.params.jugadorId);
      if (equipoId == null || jugadorId == null) {
        return res.status(400).json({ error: 'ID inválido' });
      }

      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });
      if (bundle.equipo.capitan_user_id !== user.id) {
        return res.status(403).json({ error: 'Solo el capitán puede quitar jugadores' });
      }

      const member = bundle.members.find((row) => row.id === jugadorId);
      if (!member) return res.status(404).json({ error: 'Jugador no encontrado' });
      if (member.rol === 'capitan') {
        return res.status(400).json({ error: 'No podés quitar al capitán' });
      }

      const { error } = await supabaseAdmin.from('equipos_jugadores').delete().eq('id', jugadorId);
      if (error) throw error;

      const newEstado = await refreshEquipoEstado(bundle.equipo, supabaseAdmin);
      await supabaseAdmin
        .from('equipos_usuario')
        .update({ estado: newEstado, updated_at: new Date().toISOString() })
        .eq('id', equipoId);

      const updatedBundle = await getEquipoBundle(equipoId, supabaseAdmin);
      res.json(await mapEquipoDetail(updatedBundle, supabaseAdmin, user));
    } catch (err) {
      console.error('❌ Error DELETE /api/equipos/:id/jugadores/:jugadorId:', err.message);
      return sendHttpError(res, err);
    }
  });

  router.post('/:id/inscribir-torneo', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const equipoId = parseEquipoId(req.params.id);
      const torneoId = parseEquipoId(req.body?.torneo_id);
      if (equipoId == null || torneoId == null) {
        return res.status(400).json({ error: 'equipo_id y torneo_id son requeridos' });
      }

      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });
      if (bundle.equipo.capitan_user_id !== user.id) {
        return res.status(403).json({ error: 'Solo el capitán puede inscribir el equipo' });
      }

      const acceptedMembers = bundle.members.filter((member) => member.estado === 'aceptado');
      if (acceptedMembers.length < bundle.equipo.min_jugadores) {
        return res.status(400).json({ error: 'El equipo no tiene suficientes jugadores confirmados' });
      }

      const { data: torneo, error: torneoErr } = await supabaseAdmin
        .from('torneos')
        .select('id, sede_id, deporte, nombre, estado')
        .eq('id', torneoId)
        .maybeSingle();

      if (torneoErr) throw torneoErr;
      if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });
      if (!isTorneoOpenForTeams(torneo)) {
        return res.status(409).json({ error: 'El torneo no admite nuevas inscripciones' });
      }

      const torneoDeporte = String(torneo.deporte ?? 'padbol').toLowerCase();
      if (torneoDeporte !== bundle.equipo.deporte) {
        return res.status(400).json({ error: 'El deporte del equipo no coincide con el torneo' });
      }

      const jugadoresPayload = await Promise.all(
        acceptedMembers.map(async (member) => {
          const perfil = await resolvePlayerProfile(
            { email: member.email, userId: member.user_id },
            supabaseAdmin,
          );
          return {
            nombre: member.nombre ?? perfil?.nombre ?? member.email,
            email: member.email,
            user_id: member.user_id ?? perfil?.user_id ?? null,
            es_capitan: member.rol === 'capitan',
          };
        }),
      );

      const { data: torneoEquipo, error: insertErr } = await supabaseAdmin
        .from('equipos')
        .insert([{
          torneo_id: torneoId,
          sede_id: torneo.sede_id,
          nombre: bundle.equipo.nombre,
          jugadores: jugadoresPayload,
          puntos_totales: 0,
          inscripcion_estado: 'pendiente',
        }])
        .select('id, torneo_id, sede_id, nombre, inscripcion_estado')
        .single();

      if (insertErr) throw insertErr;

      // Cancelar pendientes al inscribir
      await supabaseAdmin
        .from('equipos_jugadores')
        .update({ estado: 'cancelado', responded_at: new Date().toISOString() })
        .eq('equipo_id', equipoId)
        .eq('estado', 'pendiente');

      await supabaseAdmin
        .from('equipos_usuario')
        .update({
          torneo_id: torneoId,
          estado: 'inscripto',
          updated_at: new Date().toISOString(),
        })
        .eq('id', equipoId);

      res.json({
        success: true,
        torneo_equipo_id: torneoEquipo.id,
        torneo_id: torneoId,
        torneo_nombre: torneo.nombre,
      });
    } catch (err) {
      console.error('❌ Error POST /api/equipos/:id/inscribir-torneo:', err.message);
      return sendHttpError(res, err);
    }
  });

  return router;
}

export function mountJugadorInvitacionesEquipoRoute(app, { supabaseAdmin, getAuthenticatedUser }) {
  app.get('/api/jugador/invitaciones-equipo', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      // Reuse same logic via internal fetch to equipos router path is awkward; duplicate thin wrapper
      const filters = [`user_id.eq.${user.id}`];
      if (user.email) filters.push(`email.eq."${String(user.email).replace(/"/g, '\\"')}"`);

      let { data: pending, error } = await selectEquipoJugadores(supabaseAdmin, (q) =>
        q.or(filters.join(',')).eq('estado', 'pendiente'));
      if (error) throw error;
      pending = await expirePendingIfNeeded(pending ?? [], supabaseAdmin);
      pending = pending.filter((m) => m.estado === 'pendiente' && (m.tipo ?? 'invitacion') === 'invitacion');

      const invitaciones = [];
      for (const member of pending) {
        const bundle = await getEquipoBundle(member.equipo_id, supabaseAdmin);
        if (!bundle) continue;
        invitaciones.push({
          invitacion_id: member.id,
          equipo_id: bundle.equipo.id,
          equipo_nombre: bundle.equipo.nombre,
          deporte: bundle.equipo.deporte,
          expires_at: member.expires_at ?? null,
          equipo: await mapEquipoSummary(bundle.equipo, bundle.members, supabaseAdmin, user),
        });
      }
      res.json({ invitaciones });
    } catch (err) {
      console.error('❌ Error GET /api/jugador/invitaciones-equipo:', err.message);
      return sendHttpError(res, err);
    }
  });
}

export default createEquiposUsuarioRouter;
