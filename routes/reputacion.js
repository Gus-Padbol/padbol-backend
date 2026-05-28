const TZ_RESERVA = 'America/Argentina/Buenos_Aires';
const PENALIZACION_UMBRAL_HORAS = 24;
const PENALIZACIONES_SUSPENSION = 5;
const PENALIZACIONES_ADVERTENCIA = 3;
const VENTANA_DIAS = 30;
const SUSPENSION_DIAS = 7;

function pgUnavailable(res) {
  return res.status(503).json({ error: 'DATABASE_URL no configurada — reputación no disponible' });
}

/** Horas entre ahora (ART) y el inicio del turno. */
export function computeHorasAnticipacionReserva(fecha, hora) {
  const fy = String(fecha || '').trim().slice(0, 10);
  const hh = String(hora || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!fy || !hh) return null;
  const reservaDt = new Date(`${fy}T${hh[1].padStart(2, '0')}:${hh[2]}:00-03:00`);
  if (Number.isNaN(reservaDt.getTime())) return null;
  const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: TZ_RESERVA }));
  return (reservaDt.getTime() - nowAR.getTime()) / (1000 * 60 * 60);
}

async function resolveUserIdByEmailPg(pgPool, email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  const { rows } = await pgPool.query(
    'SELECT user_id FROM jugadores_perfil WHERE lower(trim(email)) = $1 LIMIT 1',
    [em],
  );
  const uid = rows[0]?.user_id;
  return uid ? String(uid) : null;
}

async function countPenalizaciones30dPg(pgPool, userId) {
  const { rows } = await pgPool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM cancelaciones_jugador
     WHERE user_id = $1::uuid
       AND penaliza = true
       AND created_at >= NOW() - INTERVAL '${VENTANA_DIAS} days'`,
    [userId],
  );
  return Number(rows[0]?.cnt) || 0;
}

async function fetchSuspensionActivaPg(pgPool, userId) {
  const { rows } = await pgPool.query(
    `SELECT id, suspendido_hasta, levantada_at, created_at
     FROM suspensiones_jugador
     WHERE user_id = $1::uuid
       AND levantada_at IS NULL
       AND suspendido_hasta > NOW()
     ORDER BY suspendido_hasta DESC
     LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function getReputacionPg(pgPool, userId) {
  const cancelaciones_30dias = await countPenalizaciones30dPg(pgPool, userId);
  const suspension = await fetchSuspensionActivaPg(pgPool, userId);
  return {
    cancelaciones_30dias,
    suspendido: Boolean(suspension),
    suspendido_hasta: suspension?.suspendido_hasta ?? null,
    advertencia: cancelaciones_30dias >= PENALIZACIONES_ADVERTENCIA,
  };
}

export async function assertJugadorNoSuspendidoPg(pgPool, userId) {
  if (!pgPool || !userId) return { suspendido: false };
  const suspension = await fetchSuspensionActivaPg(pgPool, userId);
  if (!suspension) return { suspendido: false };
  return {
    suspendido: true,
    suspendido_hasta: suspension.suspendido_hasta,
  };
}

async function maybeCrearSuspensionPg(pgPool, userId) {
  const activa = await fetchSuspensionActivaPg(pgPool, userId);
  if (activa) return null;

  const cnt = await countPenalizaciones30dPg(pgPool, userId);
  if (cnt < PENALIZACIONES_SUSPENSION) return null;

  const { rows } = await pgPool.query(
    `INSERT INTO suspensiones_jugador (user_id, suspendido_hasta)
     VALUES ($1::uuid, NOW() + INTERVAL '${SUSPENSION_DIAS} days')
     RETURNING id, user_id, suspendido_hasta, created_at`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Registra cancelación y evalúa suspensión. Llamar DESPUÉS de marcar reserva cancelada. */
export async function procesarReputacionTrasCancelacion(pgPool, {
  userId,
  reservaId,
  fecha,
  hora,
  horasAnticipacion: horasPrecomputed,
}) {
  if (!pgPool) {
    throw new Error('DATABASE_URL no configurada — pgPool no disponible');
  }
  const uid = String(userId || '').trim();
  const rid = parseInt(String(reservaId), 10);
  if (!uid || !Number.isFinite(rid) || rid <= 0) {
    return null;
  }

  const horas =
    horasPrecomputed != null && Number.isFinite(Number(horasPrecomputed))
      ? Number(horasPrecomputed)
      : computeHorasAnticipacionReserva(fecha, hora);
  const penaliza = horas != null ? horas < PENALIZACION_UMBRAL_HORAS : false;

  const { rows } = await pgPool.query(
    `INSERT INTO cancelaciones_jugador (user_id, reserva_id, horas_anticipacion, penaliza)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id, user_id, reserva_id, horas_anticipacion, penaliza, created_at`,
    [uid, rid, horas, penaliza],
  );

  let suspension = null;
  if (penaliza) {
    suspension = await maybeCrearSuspensionPg(pgPool, uid);
  }

  return {
    cancelacion: rows[0] ?? null,
    horas_anticipacion: horas,
    penaliza,
    suspension_creada: Boolean(suspension),
  };
}

export async function levantarSuspensionActivaPg(pgPool, userId, levantadoPor) {
  const { rows } = await pgPool.query(
    `UPDATE suspensiones_jugador
     SET levantada_at = NOW(),
         levantada_por = $2::uuid
     WHERE user_id = $1::uuid
       AND levantada_at IS NULL
       AND suspendido_hasta > NOW()
     RETURNING id, user_id, suspendido_hasta, levantada_at, levantada_por`,
    [userId, levantadoPor],
  );
  return rows[0] ?? null;
}

async function resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails }) {
  const email = String(user.email || '').trim().toLowerCase();
  const row = await fetchUserRoleRowForAuthUser(user);
  if (!row && legacySuperAdminEmails.includes(email)) {
    return { rol: 'super_admin', sede_id: null };
  }
  const sedeIdRaw = row?.sede_id;
  const sedeIdNum = sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;
  return {
    rol: String(row?.role || '').trim().toLowerCase() || null,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
  };
}

function isAdminClubOrSuper(role) {
  return role.rol === 'super_admin' || role.rol === 'admin_club';
}

export function mountReputacionRoutes(app, {
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  app.get('/api/jugador/reputacion', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const reputacion = await getReputacionPg(pgPool, user.id);
      res.json(reputacion);
    } catch (err) {
      console.error('❌ GET /api/jugador/reputacion:', err.message);
      res.status(500).json({ error: err.message || 'Error al consultar reputación' });
    }
  });

  app.get('/api/admin/jugador/:userId/reputacion', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      if (!isAdminClubOrSuper(role)) {
        return res.status(403).json({ error: 'No tenés permiso para consultar reputación de jugadores' });
      }

      const targetUserId = String(req.params.userId || '').trim();
      if (!targetUserId) {
        return res.status(400).json({ error: 'userId inválido' });
      }

      const reputacion = await getReputacionPg(pgPool, targetUserId);
      res.json({ user_id: targetUserId, ...reputacion });
    } catch (err) {
      console.error('❌ GET /api/admin/jugador/:userId/reputacion:', err.message);
      res.status(500).json({ error: err.message || 'Error al consultar reputación' });
    }
  });

  app.post('/api/admin/suspensiones/:userId/levantar', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      if (role.rol !== 'super_admin') {
        return res.status(403).json({ error: 'Solo super_admin puede levantar suspensiones' });
      }

      const targetUserId = String(req.params.userId || '').trim();
      if (!targetUserId) {
        return res.status(400).json({ error: 'userId inválido' });
      }

      const updated = await levantarSuspensionActivaPg(pgPool, targetUserId, user.id);
      if (!updated) {
        return res.status(404).json({ error: 'No hay suspensión activa para este jugador' });
      }

      res.json({ ok: true, suspension: updated });
    } catch (err) {
      console.error('❌ POST /api/admin/suspensiones/:userId/levantar:', err.message);
      res.status(500).json({ error: err.message || 'Error al levantar suspensión' });
    }
  });
}

export { resolveUserIdByEmailPg };
