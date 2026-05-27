import {
  createNotificacion,
  isNotificacionesTableMissing,
  markAllNotificacionesLeidas,
  markNotificacionLeida,
} from '../utils/notificaciones.js';

function formatHora(hora) {
  if (!hora) return null;
  return String(hora).slice(0, 5);
}

function formatPartidoFechaLabel(fecha) {
  if (!fecha) return '';
  const date = new Date(`${fecha}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(fecha);
  return date.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
}

async function fetchJugadorPerfilPublic(supabaseAdmin, userId) {
  if (!userId) return null;
  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id, nombre, apellido, apodo, username, foto_url')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function displayNameFromPerfil(perfil) {
  if (!perfil) return 'Jugador';
  const apodo = String(perfil.apodo ?? '').trim();
  if (apodo) return apodo;
  const full = [perfil.nombre, perfil.apellido].filter(Boolean).join(' ').trim();
  return full || 'Jugador';
}

function mapNotificationRow(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    titulo: row.titulo ?? null,
    mensaje: row.mensaje,
    data: row.data ?? {},
    leida: Boolean(row.leida),
    created_at: row.created_at,
  };
}

async function fetchPendingSolicitudPartidoItems(supabaseAdmin, userId) {
  const { data: partidosCapitan, error: capitanErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, sede_nombre, fecha, hora, deporte')
    .eq('capitan_user_id', userId)
    .eq('estado', 'abierto');

  if (capitanErr) throw capitanErr;

  const partidoIds = (partidosCapitan ?? []).map((row) => row.id);
  if (partidoIds.length === 0) return [];

  const { data: solicitudes, error: solErr } = await supabaseAdmin
    .from('solicitudes_partido')
    .select('id, partido_id, solicitante_id, created_at')
    .in('partido_id', partidoIds)
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: false });

  if (solErr) throw solErr;

  const partidoMap = Object.fromEntries((partidosCapitan ?? []).map((row) => [row.id, row]));

  return Promise.all(
    (solicitudes ?? []).map(async (solicitud) => {
      const perfil = await fetchJugadorPerfilPublic(supabaseAdmin, solicitud.solicitante_id);
      const partido = partidoMap[solicitud.partido_id] ?? null;
      const nombre = displayNameFromPerfil(perfil);
      const fechaLabel = formatPartidoFechaLabel(partido?.fecha);
      const horaLabel = formatHora(partido?.hora) ?? '';
      const horaSuffix = horaLabel ? ` · ${horaLabel}` : '';

      return {
        id: `solicitud-${solicitud.id}`,
        tipo: 'solicitud_partido',
        titulo: null,
        mensaje: `${nombre} quiere unirse a tu partido del ${fechaLabel}${horaSuffix}`,
        data: {
          partido_id: solicitud.partido_id,
          solicitud_id: solicitud.id,
          solicitante_id: solicitud.solicitante_id,
          solicitante_nombre: nombre,
          solicitante_foto_url: perfil?.foto_url ?? null,
          sede_nombre: partido?.sede_nombre ?? null,
          fecha: partido?.fecha ?? null,
          hora: horaLabel,
          deporte: partido?.deporte ?? 'padbol',
          _virtual: true,
        },
        leida: false,
        created_at: solicitud.created_at,
      };
    }),
  );
}

function mergeSolicitudNotifications(dbRows, pendingVirtual) {
  const coveredSolicitudIds = new Set(
    dbRows
      .filter((row) => row.tipo === 'solicitud_partido')
      .map((row) => row.data?.solicitud_id)
      .filter(Boolean),
  );

  const virtualOnly = pendingVirtual.filter(
    (row) => !coveredSolicitudIds.has(row.data?.solicitud_id),
  );

  return [...dbRows, ...virtualOnly].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export function mountNotificacionesRoutes(app, { supabaseAdmin, getAuthenticatedUser }) {
  app.get('/api/notificaciones', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      let dbRows = [];
      try {
        const { data, error } = await supabaseAdmin
          .from('notificaciones')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(100);

        if (error) throw error;
        dbRows = (data ?? []).map(mapNotificationRow);
      } catch (err) {
        if (!isNotificacionesTableMissing(err)) throw err;
        console.warn('⚠️ GET /api/notificaciones — tabla no disponible:', err.message);
      }

      let pendingVirtual = [];
      try {
        pendingVirtual = await fetchPendingSolicitudPartidoItems(supabaseAdmin, user.id);
      } catch (pendingErr) {
        console.warn('⚠️ fetchPendingSolicitudPartidoItems:', pendingErr.message);
      }

      const notificaciones = mergeSolicitudNotifications(dbRows, pendingVirtual);
      const unread_count = notificaciones.filter((row) => !row.leida).length;

      res.json({ notificaciones, unread_count });
    } catch (err) {
      console.error('❌ Error GET /api/notificaciones:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/notificaciones/leer-todas', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      try {
        await markAllNotificacionesLeidas(supabaseAdmin, user.id);
      } catch (err) {
        if (!isNotificacionesTableMissing(err)) throw err;
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Error PATCH /api/notificaciones/leer-todas:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/notificaciones/:id/leer', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const rawId = String(req.params.id ?? '');
      if (rawId.startsWith('solicitud-')) {
        return res.json({ ok: true, virtual: true });
      }

      try {
        const row = await markNotificacionLeida(supabaseAdmin, rawId, user.id);
        if (!row) {
          return res.status(404).json({ error: 'Notificación no encontrada' });
        }
        return res.json({ ok: true, notificacion: mapNotificationRow(row) });
      } catch (err) {
        if (isNotificacionesTableMissing(err)) {
          return res.json({ ok: true });
        }
        throw err;
      }
    } catch (err) {
      console.error('❌ Error PATCH /api/notificaciones/:id/leer:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
