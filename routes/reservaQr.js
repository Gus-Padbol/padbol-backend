import crypto from 'crypto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Acepta bigint (string numérico) o UUID. */
export function parseReservaRouteId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (UUID_REGEX.test(s)) return { kind: 'uuid', value: s };
  if (/^\d+$/.test(s)) return { kind: 'numeric', value: s };
  return null;
}

async function fetchReservaForQrPg(pgPool, parsedId) {
  const { rows } = await pgPool.query(
    `SELECT id, user_id, email, sede, qr_token
     FROM reservas
     WHERE id::text = $1
     LIMIT 1`,
    [parsedId.value],
  );
  return rows[0] ?? null;
}

function applySupabaseReservaIdFilter(query, parsedId) {
  if (parsedId.kind === 'numeric') {
    const asNum = Number(parsedId.value);
    if (!Number.isSafeInteger(asNum)) {
      const err = new Error('ID numérico requiere DATABASE_URL configurada');
      err.status = 503;
      throw err;
    }
    return query.eq('id', asNum);
  }
  return query.eq('id', parsedId.value);
}

async function fetchReservaForQrSupabase(supabaseAdmin, parsedId) {
  let query = supabaseAdmin
    .from('reservas')
    .select('id, user_id, email, sede, qr_token');

  query = applySupabaseReservaIdFilter(query, parsedId);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function updateReservaQrTokenPg(pgPool, reservaIdText, qrToken) {
  const { rows } = await pgPool.query(
    `UPDATE reservas
     SET qr_token = $2
     WHERE id::text = $1
     RETURNING qr_token`,
    [reservaIdText, qrToken],
  );
  return rows[0]?.qr_token ?? qrToken;
}

async function updateReservaQrTokenSupabase(supabaseAdmin, parsedId, qrToken) {
  let query = supabaseAdmin.from('reservas').update({ qr_token: qrToken });
  query = applySupabaseReservaIdFilter(query, parsedId);
  const { data, error } = await query.select('qr_token').maybeSingle();
  if (error) throw error;
  return data?.qr_token ?? qrToken;
}

async function assertPuedeGenerarQrReserva({
  user,
  reserva,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails,
  pgPool,
  supabaseAdmin,
}) {
  const email = String(user.email || '').trim().toLowerCase();
  const roleRow = await fetchUserRoleRowForAuthUser(user);
  const rol = String(roleRow?.role || roleRow?.rol || '').trim().toLowerCase();

  if (legacySuperAdminEmails?.includes(email) || rol === 'super_admin') {
    return;
  }

  if (reserva.user_id && String(reserva.user_id) === String(user.id)) {
    return;
  }

  if (reserva.email && String(reserva.email).trim().toLowerCase() === email) {
    return;
  }

  if (rol === 'admin_club' && roleRow?.sede_id != null) {
    let sedeNombre = null;
    if (pgPool) {
      const { rows } = await pgPool.query('SELECT nombre FROM sedes WHERE id = $1 LIMIT 1', [roleRow.sede_id]);
      sedeNombre = rows[0]?.nombre ?? null;
    } else if (supabaseAdmin) {
      const { data } = await supabaseAdmin.from('sedes').select('nombre').eq('id', roleRow.sede_id).maybeSingle();
      sedeNombre = data?.nombre ?? null;
    }
    if (sedeNombre && String(reserva.sede || '').trim() === String(sedeNombre).trim()) {
      return;
    }
  }

  const err = new Error('No tenés permiso para generar QR de esta reserva');
  err.status = 403;
  throw err;
}

export function mountReservaQrRoutes(app, deps) {
  const {
    pgPool,
    supabaseAdmin,
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  } = deps;

  app.post('/api/reservas/:id/generar-qr', async (req, res) => {
    try {
      const parsedId = parseReservaRouteId(req.params.id);
      if (!parsedId) {
        return res.status(400).json({ error: 'ID de reserva inválido' });
      }

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      let reserva = null;
      if (pgPool) {
        reserva = await fetchReservaForQrPg(pgPool, parsedId);
      } else if (supabaseAdmin) {
        reserva = await fetchReservaForQrSupabase(supabaseAdmin, parsedId);
      }

      if (!reserva) {
        return res.status(404).json({ error: 'Reserva no encontrada' });
      }

      await assertPuedeGenerarQrReserva({
        user,
        reserva,
        fetchUserRoleRowForAuthUser,
        legacySuperAdminEmails,
        pgPool,
        supabaseAdmin,
      });

      const idForToken = String(reserva.id);
      const qr_token = `QR-${idForToken}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;

      let savedToken = qr_token;
      if (pgPool) {
        try {
          savedToken = await updateReservaQrTokenPg(pgPool, idForToken, qr_token);
        } catch (pgErr) {
          if (!/qr_token|colum|column/i.test(String(pgErr.message || ''))) throw pgErr;
          if (!supabaseAdmin) throw pgErr;
          savedToken = await updateReservaQrTokenSupabase(supabaseAdmin, parsedId, qr_token);
        }
      } else if (supabaseAdmin) {
        savedToken = await updateReservaQrTokenSupabase(supabaseAdmin, parsedId, qr_token);
      }

      console.log(`✓ POST /api/reservas/${idForToken}/generar-qr — token generado`);
      return res.json({ qr_token: savedToken });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) {
        return res.status(st).json({ error: err.message || String(err) });
      }
      console.error('❌ POST /api/reservas/:id/generar-qr:', err.message);
      return res.status(500).json({ error: err.message || 'Error al generar QR' });
    }
  });
}
