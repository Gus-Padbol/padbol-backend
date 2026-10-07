import { requireAdminUser, requireSuperAdminUser } from '../lib/authAccess.js';

const ACTIVE_RESERVATION_STATES = new Set(['confirmada', 'completada', 'pagada', 'finalizada']);

function startOfCurrentMonthIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function normalizedSport(row) {
  return String(row?.deporte || row?.sport || 'padbol').trim().toLowerCase() || 'padbol';
}

function sportLabel(value) {
  if (value === 'futbol') return 'Fútbol';
  if (value === 'padel') return 'Pádel';
  if (value === 'tenis') return 'Tenis';
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : '—';
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

async function rowsOrThrow(query) {
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function buildGlobalAdminAnalytics(supabaseAdmin, now = new Date()) {
  const monthStart = startOfCurrentMonthIso(now);
  const [profiles, activeVenues, tournaments, recentReservations, venues, courts] = await Promise.all([
    rowsOrThrow(supabaseAdmin.from('perfiles').select('id,created_at')),
    rowsOrThrow(supabaseAdmin.from('sedes').select('id,pais,estado')),
    rowsOrThrow(supabaseAdmin.from('torneos').select('id,deporte,estado,fecha_fin')),
    rowsOrThrow(supabaseAdmin.from('reservas').select('id,estado,cancelada,fecha,created_at,deporte,cancha_id')),
    rowsOrThrow(supabaseAdmin.from('sedes').select('id,pais,estado')),
    optionalRows(supabaseAdmin.from('canchas').select('id,deporte')),
  ]);

  const newProfiles = profiles.filter((row) => String(row?.created_at || '') >= monthStart).length;
  const activeVenueRows = activeVenues.filter((row) => !['inactiva', 'suspendida', 'rechazada'].includes(String(row?.estado || '').toLowerCase()));
  const finishedTournaments = tournaments.filter((row) => {
    const state = String(row?.estado || '').toLowerCase();
    return ['finalizado', 'finalizada', 'completado', 'completada'].includes(state)
      || (row?.fecha_fin && String(row.fecha_fin).slice(0, 10) < now.toISOString().slice(0, 10));
  });
  const reservationsLastMonth = recentReservations.filter((row) => {
    const created = String(row?.fecha || row?.created_at || '');
    const state = String(row?.estado || '').toLowerCase();
    return created >= monthStart && row?.cancelada !== true && ACTIVE_RESERVATION_STATES.has(state);
  });
  const courtSport = new Map(courts.map((court) => [String(court.id), normalizedSport(court)]));
  const completedReservations = recentReservations.filter((row) =>
    row?.cancelada !== true && ACTIVE_RESERVATION_STATES.has(String(row?.estado || '').toLowerCase()));
  const sportRanking = countBy(completedReservations, (row) => {
    const direct = String(row?.deporte || '').trim();
    return direct ? normalizedSport(row) : courtSport.get(String(row?.cancha_id || '')) || 'padbol';
  });
  const topSport = sportRanking[0] || [null, 0];
  const countries = countBy(venues, (row) => String(row?.pais || '').trim() || null)
    .slice(0, 5)
    .map(([pais, sedes_total]) => ({ pais, sedes_total }));

  return {
    jugadores_registrados_total: profiles.length,
    jugadores_nuevos_este_mes: newProfiles,
    sedes_activas_total: activeVenueRows.length,
    torneos_finalizados_total: finishedTournaments.length,
    reservas_ultimo_mes_total: reservationsLastMonth.length,
    deporte_mas_popular: {
      deporte: topSport[0],
      label: sportLabel(topSport[0]),
      reservas_realizadas: topSport[1],
      // Alias temporal para clientes previos; el valor ya representa reservas,
      // no torneos creados.
      torneos_creados: topSport[1],
    },
    sedes_por_pais_top5: countries,
    generated_at: now.toISOString(),
  };
}

function isMissingRelation(error) {
  return error?.code === '42P01' || /does not exist|not found|schema cache/i.test(String(error?.message || ''));
}

async function optionalRows(query) {
  const { data, error } = await query;
  if (error && !isMissingRelation(error)) throw error;
  return Array.isArray(data) ? data : [];
}

export function mountAdminQaPanelRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const authDeps = { getAuthenticatedUser, fetchUserRoleRowForAuthUser, legacySuperAdminEmails };

  app.get('/api/admin/analytics-globales', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      return res.json(await buildGlobalAdminAnalytics(supabaseAdmin));
    } catch (error) {
      console.error('GET /api/admin/analytics-globales:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar las métricas globales', retryable: true });
    }
  });

  app.get('/api/contratos-sedes', async (req, res) => {
    try {
      const auth = await requireSuperAdminUser(req, res, authDeps);
      if (!auth) return;
      const ids = String(req.query?.sede_ids || '').split(',').map(Number).filter(Number.isFinite);
      if (!ids.length) return res.json([]);
      const rows = await optionalRows(supabaseAdmin.from('contratos_sedes').select('*').in('sede_id', ids));
      return res.json(rows);
    } catch (error) {
      console.error('GET /api/contratos-sedes:', error.message);
      return res.status(500).json({ error: 'No se pudieron cargar los contratos de las sedes', retryable: true });
    }
  });

  app.get('/api/hub-config', async (_req, res) => {
    try {
      return res.json(await optionalRows(supabaseAdmin.from('hub_config').select('*').order('id')));
    } catch (error) {
      return res.status(500).json({ error: 'No se pudo cargar la configuración general del Hub', retryable: true });
    }
  });

  app.get('/api/hub-config/inicio-cards', async (_req, res) => {
    try {
      const rows = await optionalRows(supabaseAdmin.from('hub_config').select('*').in('id', [
        'inicio_reservar', 'inicio_jugar', 'inicio_competir', 'inicio_clases',
      ]));
      return res.json(rows);
    } catch (error) {
      return res.status(500).json({ error: 'No se pudieron cargar las tarjetas de inicio', retryable: true });
    }
  });

  app.patch('/api/hub-config/:id', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, authDeps);
      if (!auth) return;
      const id = String(req.params?.id || '').trim();
      if (!id || !/^[a-z0-9_-]{1,80}$/i.test(id)) return res.status(400).json({ error: 'Tarjeta inválida' });
      const allowed = ['titulo', 'subtitulo', 'foto_url', 'chivi_imagen_url'];
      const payload = { id };
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) payload[key] = String(req.body[key] || '').trim();
      }
      if (Object.keys(payload).length === 1) return res.status(400).json({ error: 'No hay cambios para guardar' });
      const { data, error } = await supabaseAdmin.from('hub_config')
        .upsert(payload, { onConflict: 'id' }).select('*').single();
      if (error) throw error;
      return res.json(data);
    } catch (error) {
      return res.status(error?.status || 500).json({ error: error?.message || 'No se pudo guardar la tarjeta del Hub' });
    }
  });

  app.get('/api/hub-deporte-config', async (req, res) => {
    try {
      let query = supabaseAdmin.from('hub_deporte_config').select('*').order('deporte').order('card_key');
      if (req.query?.deporte) query = query.eq('deporte', String(req.query.deporte).trim().toLowerCase());
      return res.json(await optionalRows(query));
    } catch (error) {
      return res.status(500).json({ error: 'No se pudo cargar la configuración deportiva del Hub', retryable: true });
    }
  });

  app.patch('/api/hub-deporte-config', async (req, res) => {
    try {
      const auth = await requireAdminUser(req, res, authDeps);
      if (!auth) return;
      const deporte = String(req.body?.deporte || '').trim().toLowerCase();
      const cardKey = String(req.body?.card_key || '').trim();
      if (!deporte || !cardKey) return res.status(400).json({ error: 'Deporte y tarjeta son obligatorios' });
      const payload = {
        deporte,
        card_key: cardKey,
        titulo: String(req.body?.titulo || '').trim(),
        subtitulo: String(req.body?.subtitulo || '').trim(),
      };
      const { data, error } = await supabaseAdmin.from('hub_deporte_config')
        .upsert(payload, { onConflict: 'deporte,card_key' }).select('*').single();
      if (error) throw error;
      return res.json(data);
    } catch (error) {
      return res.status(error?.status || 500).json({ error: error?.message || 'No se pudo guardar la tarjeta del Hub' });
    }
  });
}
