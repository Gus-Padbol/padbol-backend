import express from 'express';
import { maskEmail } from '../lib/safeLog.js';

const DEPORTE_LIMITS = {
  padbol: { min: 2, max: 4, label: 'Padbol' },
  padel: { min: 4, max: 4, label: 'Pádel' },
  pickleball: { min: 2, max: 4, label: 'Pickleball' },
  futbol_5: { min: 5, max: 13, label: 'Fútbol 5' },
  futbol_7: { min: 7, max: 17, label: 'Fútbol 7' },
};

function parseEquipoId(id) {
  const equipoId = parseInt(id, 10);
  if (Number.isNaN(equipoId)) return null;
  return equipoId;
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

async function resolvePlayerProfile({ email, userId }, supabaseAdmin) {
  const filters = [];
  if (userId) filters.push(`user_id.eq.${userId}`);
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);

  if (filters.length === 0) return null;

  const { data } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('nombre, email, user_id, foto_url, expo_push_token')
    .or(filters.join(','))
    .maybeSingle();

  return data;
}

async function sendTeamInvitationNotifications({
  supabaseAdmin,
  equipo,
  capitanNombre,
  inviteeEmail,
}) {
  const perfil = await resolvePlayerProfile({ email: inviteeEmail }, supabaseAdmin);

  console.log(
    `[EMAIL] Invitación equipo id=${equipo.id} (${equipo.deporte}) → ${maskEmail(inviteeEmail)}`,
  );

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
  if (equipo.torneo_id) {
    return 'inscripto';
  }

  const accepted = await countAcceptedMembers(equipo.id, supabaseAdmin);
  if (accepted >= equipo.min_jugadores) return 'completo';
  return 'formando';
}

async function mapEquipoSummary(equipo, members, supabaseAdmin, user = null) {
  const capitanPerfil = await resolvePlayerProfile(
    { userId: equipo.capitan_user_id, email: equipo.capitan_email },
    supabaseAdmin,
  );
  const accepted = members.filter((member) => member.estado === 'aceptado').length;
  const pending = members.filter((member) => member.estado === 'pendiente').length;
  const estado = equipo.torneo_id ? 'inscripto' : (accepted >= equipo.min_jugadores ? 'completo' : 'formando');

  const myMembership = user
    ? members.find(
      (member) =>
        member.user_id === user.id
        || normalizeEmail(member.email) === normalizeEmail(user.email),
    )
    : null;

  return {
    id: equipo.id,
    nombre: equipo.nombre,
    deporte: equipo.deporte,
    deporte_label: DEPORTE_LIMITS[equipo.deporte]?.label ?? equipo.deporte,
    estado,
    min_jugadores: equipo.min_jugadores,
    max_jugadores: equipo.max_jugadores,
    miembros_total: members.length,
    miembros_aceptados: accepted,
    miembros_pendientes: pending,
    capitan_user_id: equipo.capitan_user_id,
    capitan_nombre: capitanPerfil?.nombre ?? equipo.capitan_email ?? 'Capitán',
    capitan_email: equipo.capitan_email ?? null,
    torneo_id: equipo.torneo_id ?? null,
    es_capitan: user ? equipo.capitan_user_id === user.id : false,
    mi_estado: myMembership?.estado ?? null,
    created_at: equipo.created_at,
  };
}

async function getEquipoBundle(equipoId, supabaseAdmin) {
  const { data: equipo, error } = await supabaseAdmin
    .from('equipos_usuario')
    .select('*')
    .eq('id', equipoId)
    .maybeSingle();

  if (error) throw error;
  if (!equipo) return null;

  const { data: members, error: membersErr } = await supabaseAdmin
    .from('equipos_jugadores')
    .select('*')
    .eq('equipo_id', equipoId)
    .order('invited_at', { ascending: true });

  if (membersErr) throw membersErr;

  return { equipo, members: members ?? [] };
}

async function mapEquipoDetail(bundle, supabaseAdmin, user) {
  const enrichedMembers = await Promise.all(
    bundle.members.map(async (member) => {
      const perfil = await resolvePlayerProfile(
        { email: member.email, userId: member.user_id },
        supabaseAdmin,
      );

      return {
        id: member.id,
        user_id: member.user_id ?? perfil?.user_id ?? null,
        email: member.email,
        nombre: member.nombre ?? perfil?.nombre ?? member.email,
        foto_url: perfil?.foto_url ?? null,
        rol: member.rol,
        estado: member.estado,
      };
    }),
  );

  return {
    ...(await mapEquipoSummary(bundle.equipo, bundle.members, supabaseAdmin, user)),
    jugadores: enrichedMembers,
  };
}

export function createEquiposUsuarioRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  router.get('/buscar-jugador', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) return res.status(status).json({ error: authError });

      const query = String(req.query.query ?? req.query.q ?? '').trim();
      if (query.length < 2) {
        return res.json([]);
      }

      const escaped = query.replace(/"/g, '\\"');
      const { data, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .select('nombre, email, user_id, foto_url')
        .or(`email.ilike."%${escaped}%",nombre.ilike."%${escaped}%"`)
        .limit(10);

      if (error) throw error;

      res.json(
        (data ?? [])
          .filter((row) => normalizeEmail(row.email) !== normalizeEmail(user.email))
          .map((row) => ({
            user_id: row.user_id ?? null,
            email: row.email,
            nombre: row.nombre ?? row.email,
            foto_url: row.foto_url ?? null,
          })),
      );
    } catch (err) {
      console.error('❌ Error GET /api/equipos/buscar-jugador:', err.message);
      res.status(500).json({ error: err.message });
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
          supabaseAdmin.from('equipos_usuario').select('*').eq('capitan_user_id', user.id),
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
        const { data, error } = await supabaseAdmin
          .from('equipos_usuario')
          .select('*')
          .in('id', memberEquipoIds);
        if (error) throw error;
        memberEquipos = data ?? [];
      }

      const byId = new Map();
      [...(capitanEquipos ?? []), ...memberEquipos].forEach((equipo) => {
        byId.set(equipo.id, equipo);
      });

      const result = await Promise.all(
        [...byId.values()].map(async (equipo) => {
          const { data: members, error } = await supabaseAdmin
            .from('equipos_jugadores')
            .select('*')
            .eq('equipo_id', equipo.id);
          if (error) throw error;
          return mapEquipoSummary(equipo, members ?? [], supabaseAdmin, user);
        }),
      );

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/equipos/mis-equipos:', err.message);
      res.status(500).json({ error: err.message });
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

      if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
      if (!limits) return res.status(400).json({ error: 'deporte inválido' });

      const uniqueEmails = [...new Set(inviteEmails)]
        .filter((email) => email !== normalizeEmail(user.email));

      if (uniqueEmails.length + 1 > limits.max) {
        return res.status(400).json({ error: `Máximo ${limits.max} jugadores para ${limits.label}` });
      }

      const capitanPerfil = await resolvePlayerProfile({ userId: user.id, email: user.email }, supabaseAdmin);
      const now = new Date().toISOString();

      const { data: equipo, error: insertErr } = await supabaseAdmin
        .from('equipos_usuario')
        .insert([{
          nombre,
          deporte,
          capitan_user_id: user.id,
          capitan_email: user.email ?? null,
          min_jugadores: limits.min,
          max_jugadores: limits.max,
          estado: 'formando',
          updated_at: now,
        }])
        .select('*')
        .single();

      if (insertErr) throw insertErr;

      const memberRows = [
        {
          equipo_id: equipo.id,
          user_id: user.id,
          email: normalizeEmail(user.email),
          nombre: capitanPerfil?.nombre ?? user.email,
          rol: 'capitan',
          estado: 'aceptado',
          invited_at: now,
          responded_at: now,
        },
        ...uniqueEmails.map((email) => ({
          equipo_id: equipo.id,
          email,
          rol: 'jugador',
          estado: 'pendiente',
          invited_at: now,
        })),
      ];

      const { error: membersErr } = await supabaseAdmin
        .from('equipos_jugadores')
        .insert(memberRows);

      if (membersErr) throw membersErr;

      await Promise.all(
        uniqueEmails.map((email) =>
          sendTeamInvitationNotifications({
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
      res.status(500).json({ error: err.message });
    }
  });

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
      res.status(500).json({ error: err.message });
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

      const membership = bundle.members.find(
        (member) =>
          normalizeEmail(member.email) === normalizeEmail(user.email)
          || (member.user_id && member.user_id === user.id),
      );

      if (!membership) {
        return res.status(404).json({ error: 'No tenés invitación para este equipo' });
      }

      if (membership.estado !== 'pendiente') {
        return res.status(400).json({ error: 'La invitación ya fue respondida' });
      }

      if (nextEstado === 'aceptado') {
        const accepted = await countAcceptedMembers(equipoId, supabaseAdmin);
        if (accepted >= bundle.equipo.max_jugadores) {
          return res.status(409).json({ error: 'El equipo ya está completo' });
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
        .eq('id', membership.id);

      if (updateErr) throw updateErr;

      const newEstado = await refreshEquipoEstado(bundle.equipo, supabaseAdmin);
      await supabaseAdmin
        .from('equipos_usuario')
        .update({ estado: newEstado, updated_at: now })
        .eq('id', equipoId);

      const updatedBundle = await getEquipoBundle(equipoId, supabaseAdmin);
      res.json({
        success: true,
        estado: nextEstado,
        equipo: await mapEquipoDetail(updatedBundle, supabaseAdmin, user),
      });
    } catch (err) {
      console.error(`❌ Error POST /api/equipos/:id/${nextEstado}:`, err.message);
      res.status(500).json({ error: err.message });
    }
  }

  router.post('/:id/aceptar', (req, res) => respondInvitation(req, res, 'aceptado'));
  router.post('/:id/rechazar', (req, res) => respondInvitation(req, res, 'rechazado'));

  router.post('/:id/invitar', async (req, res) => {
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

      if (emails.length === 0) {
        return res.status(400).json({ error: 'Se requiere al menos un email' });
      }

      const bundle = await getEquipoBundle(equipoId, supabaseAdmin);
      if (!bundle) return res.status(404).json({ error: 'Equipo no encontrado' });
      if (bundle.equipo.capitan_user_id !== user.id) {
        return res.status(403).json({ error: 'Solo el capitán puede invitar jugadores' });
      }

      const accepted = await countAcceptedMembers(equipoId, supabaseAdmin);
      const pending = bundle.members.filter((member) => member.estado === 'pendiente').length;
      if (accepted + pending + emails.length > bundle.equipo.max_jugadores) {
        return res.status(409).json({ error: 'Supera el máximo de jugadores del equipo' });
      }

      const capitanPerfil = await resolvePlayerProfile(
        { userId: user.id, email: user.email },
        supabaseAdmin,
      );
      const now = new Date().toISOString();

      for (const email of [...new Set(emails)]) {
        const existing = bundle.members.find((member) => normalizeEmail(member.email) === email);
        if (existing) continue;

        const { error } = await supabaseAdmin.from('equipos_jugadores').insert([{
          equipo_id: equipoId,
          email,
          rol: 'jugador',
          estado: 'pendiente',
          invited_at: now,
        }]);
        if (error) throw error;

        await sendTeamInvitationNotifications({
          supabaseAdmin,
          equipo: bundle.equipo,
          capitanNombre: capitanPerfil?.nombre ?? user.email ?? 'Capitán',
          inviteeEmail: email,
        });
      }

      const updatedBundle = await getEquipoBundle(equipoId, supabaseAdmin);
      res.json(await mapEquipoDetail(updatedBundle, supabaseAdmin, user));
    } catch (err) {
      console.error('❌ Error POST /api/equipos/:id/invitar:', err.message);
      res.status(500).json({ error: err.message });
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

      const { error } = await supabaseAdmin
        .from('equipos_jugadores')
        .delete()
        .eq('id', jugadorId);

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
      res.status(500).json({ error: err.message });
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
        .select('id, sede_id, deporte, nombre')
        .eq('id', torneoId)
        .maybeSingle();

      if (torneoErr) throw torneoErr;
      if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });

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
        .select('*')
        .single();

      if (insertErr) throw insertErr;

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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createEquiposUsuarioRouter;
