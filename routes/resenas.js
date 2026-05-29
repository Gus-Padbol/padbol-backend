const RESENAS_TABLE = 'resenas';
const LIST_LIMIT = 50;

function parseSedeId(raw) {
  const sedeId = parseInt(String(raw), 10);
  return Number.isFinite(sedeId) && sedeId > 0 ? sedeId : null;
}

function parseResenaId(raw) {
  const id = String(raw || '').trim();
  return id || null;
}

function parsePuntuacion(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

function pgUnavailable(res) {
  return res.status(503).json({ error: 'DATABASE_URL no configurada — reseñas no disponibles' });
}

function buildDisplayNameFromPerfil(perfil, fallbackNombre = '') {
  if (perfil) {
    const nombre = String(perfil.nombre ?? '').trim();
    const apellido = String(perfil.apellido ?? '').trim();
    const full = [nombre, apellido].filter(Boolean).join(' ');
    if (full) return full;
    const apodo = String(perfil.apodo ?? '').trim();
    if (apodo) return apodo;
    if (perfil.username) return String(perfil.username).trim();
  }
  const cached = String(fallbackNombre ?? '').trim();
  return cached || 'Usuario';
}

function mapResenaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sede_id: row.sede_id,
    user_id: row.user_id,
    reserva_id: null,
    puntuacion: Number(row.puntuacion ?? row.estrellas),
    comentario: row.comentario ?? '',
    created_at: row.created_at,
    respuesta_admin: row.respuesta_admin ?? null,
    respuesta_at: row.respuesta_at ?? row.fecha_respuesta ?? null,
    respuesta_por: row.respuesta_por ?? null,
    display_name: row.display_name ?? 'Usuario',
    foto_url: row.foto_url ?? null,
  };
}

const RESENA_SELECT_SQL = `
  SELECT
    r.id,
    r.sede_id,
    r.user_id,
    r.estrellas AS puntuacion,
    r.comentario,
    r.created_at,
    r.respuesta_admin,
    r.fecha_respuesta AS respuesta_at,
    COALESCE(
      NULLIF(TRIM(jp.apodo), ''),
      NULLIF(TRIM(CONCAT(COALESCE(jp.nombre, ''), ' ', COALESCE(jp.apellido, ''))), ''),
      NULLIF(TRIM(r.nombre), ''),
      'Usuario'
    ) AS display_name,
    jp.foto_url
  FROM ${RESENAS_TABLE} r
  LEFT JOIN jugadores_perfil jp ON jp.user_id = r.user_id
`;

async function sedeExistsPg(pgPool, sedeId) {
  const { rows } = await pgPool.query('SELECT id FROM sedes WHERE id = $1 LIMIT 1', [sedeId]);
  return Boolean(rows[0]);
}

async function fetchResenasStatsPg(pgPool, sedeId) {
  const { rows } = await pgPool.query(
    `SELECT
       COUNT(*)::int AS total,
       ROUND(AVG(estrellas::numeric), 1) AS promedio
     FROM ${RESENAS_TABLE}
     WHERE sede_id = $1`,
    [sedeId],
  );
  const row = rows[0] ?? {};
  return {
    total: Number(row.total) || 0,
    promedio: row.promedio != null ? Number(row.promedio) : null,
  };
}

async function userHasResenaPg(pgPool, { sedeId, userId }) {
  const { rows } = await pgPool.query(
    `SELECT id FROM ${RESENAS_TABLE}
     WHERE sede_id = $1 AND user_id = $2::uuid
     LIMIT 1`,
    [sedeId, userId],
  );
  return Boolean(rows[0]);
}

async function fetchNombreAutorPg(pgPool, userId) {
  const { rows } = await pgPool.query(
    `SELECT nombre, apellido, apodo, username
     FROM jugadores_perfil
     WHERE user_id = $1::uuid
     LIMIT 1`,
    [userId],
  );
  return buildDisplayNameFromPerfil(rows[0]);
}

async function insertResenaPg(pgPool, { sedeId, userId, puntuacion, comentario }) {
  const comentarioVal = comentario != null && String(comentario).trim() !== ''
    ? String(comentario).trim().slice(0, 500)
    : null;
  const nombreAutor = await fetchNombreAutorPg(pgPool, userId);

  try {
    const { rows } = await pgPool.query(
      `INSERT INTO ${RESENAS_TABLE} (sede_id, user_id, estrellas, comentario, nombre)
       VALUES ($1, $2::uuid, $3, $4, $5)
       RETURNING id, sede_id, user_id,
         estrellas AS puntuacion,
         comentario, created_at, respuesta_admin,
         fecha_respuesta AS respuesta_at,
         nombre`,
      [sedeId, userId, puntuacion, comentarioVal, nombreAutor],
    );
    return rows[0];
  } catch (err) {
    if (err?.code !== '42703') throw err;
    const { rows } = await pgPool.query(
      `INSERT INTO ${RESENAS_TABLE} (sede_id, user_id, estrellas, comentario)
       VALUES ($1, $2::uuid, $3, $4)
       RETURNING id, sede_id, user_id,
         estrellas AS puntuacion,
         comentario, created_at, respuesta_admin,
         fecha_respuesta AS respuesta_at`,
      [sedeId, userId, puntuacion, comentarioVal],
    );
    return rows[0];
  }
}

async function fetchResenaByIdPg(pgPool, resenaId) {
  const { rows } = await pgPool.query(
    `${RESENA_SELECT_SQL} WHERE r.id = $1::uuid LIMIT 1`,
    [resenaId],
  );
  return rows[0] ?? null;
}

async function updateResenaRespuestaPg(pgPool, { resenaId, respuestaAdmin }) {
  const text = String(respuestaAdmin ?? '').trim();
  const { rows } = await pgPool.query(
    `UPDATE ${RESENAS_TABLE}
     SET respuesta_admin = $1,
         fecha_respuesta = NOW()
     WHERE id = $2::uuid
     RETURNING id, sede_id, user_id,
       estrellas AS puntuacion,
       comentario, created_at, respuesta_admin,
       fecha_respuesta AS respuesta_at`,
    [text || null, resenaId],
  );
  return rows[0] ?? null;
}

async function deleteResenaPg(pgPool, resenaId) {
  const { rowCount } = await pgPool.query(
    `DELETE FROM ${RESENAS_TABLE} WHERE id = $1::uuid`,
    [resenaId],
  );
  return rowCount > 0;
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

function canRespondToResena(role, resenaSedeId) {
  if (role.rol === 'super_admin') return true;
  if (role.rol === 'admin_club' && role.sede_id != null && Number(role.sede_id) === Number(resenaSedeId)) {
    return true;
  }
  return false;
}

export function mountResenasRoutes(app, {
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const handleGetResenas = async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      if (!(await sedeExistsPg(pgPool, sedeId))) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const { rows } = await pgPool.query(
        `${RESENA_SELECT_SQL}
         WHERE r.sede_id = $1
         ORDER BY r.created_at DESC
         LIMIT ${LIST_LIMIT}`,
        [sedeId],
      );

      const stats = await fetchResenasStatsPg(pgPool, sedeId);
      const resenas = rows.map(mapResenaRow);

      res.json({
        resenas,
        promedio: stats.promedio,
        total: stats.total,
      });
    } catch (err) {
      console.error('❌ GET /api/sedes/:id/resenas:', err.message);
      res.status(500).json({ error: err.message || 'Error al listar reseñas' });
    }
  };

  app.get('/api/sedes/:id/resenas', handleGetResenas);
  app.get('/api/sedes/:id/reseñas', handleGetResenas);

  const handlePostResena = async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      const { puntuacion: rawPuntuacion, estrellas, comentario } = req.body ?? {};
      const puntuacion = parsePuntuacion(rawPuntuacion ?? estrellas);
      if (puntuacion == null) {
        return res.status(400).json({ error: 'puntuacion debe ser un entero entre 1 y 5' });
      }

      if (!(await sedeExistsPg(pgPool, sedeId))) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const duplicate = await userHasResenaPg(pgPool, {
        sedeId,
        userId: user.id,
      });
      if (duplicate) {
        return res.status(409).json({ error: 'Ya reseñaste esta sede' });
      }

      const inserted = await insertResenaPg(pgPool, {
        sedeId,
        userId: user.id,
        puntuacion,
        comentario,
      });

      const enriched = inserted?.id
        ? await fetchResenaByIdPg(pgPool, inserted.id)
        : inserted;

      res.status(201).json({ resena: mapResenaRow(enriched ?? inserted) });
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'Ya existe una reseña para esta sede' });
      }
      console.error('❌ POST /api/sedes/:id/resenas:', err.message);
      res.status(500).json({ error: err.message || 'Error al crear reseña' });
    }
  };

  app.post('/api/sedes/:id/resenas', handlePostResena);
  app.post('/api/sedes/:id/reseñas', handlePostResena);

  app.patch('/api/admin/resenas/:id/respuesta', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const resenaId = parseResenaId(req.params.id);
      if (!resenaId) {
        return res.status(400).json({ error: 'ID de reseña inválido' });
      }

      const existing = await fetchResenaByIdPg(pgPool, resenaId);
      if (!existing) {
        return res.status(404).json({ error: 'Reseña no encontrada' });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      if (!canRespondToResena(role, existing.sede_id)) {
        return res.status(403).json({ error: 'No tenés permiso para responder esta reseña' });
      }

      const respuestaAdmin = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'respuesta_admin')
        ? req.body.respuesta_admin
        : req.body?.respuesta;

      if (respuestaAdmin == null || String(respuestaAdmin).trim() === '') {
        return res.status(400).json({ error: 'respuesta_admin es requerido' });
      }

      const updated = await updateResenaRespuestaPg(pgPool, {
        resenaId,
        respuestaAdmin,
      });
      if (!updated) {
        return res.status(404).json({ error: 'Reseña no encontrada' });
      }

      const enriched = await fetchResenaByIdPg(pgPool, resenaId);
      res.json({ resena: mapResenaRow(enriched ?? updated) });
    } catch (err) {
      console.error('❌ PATCH /api/admin/resenas/:id/respuesta:', err.message);
      res.status(500).json({ error: err.message || 'Error al actualizar respuesta' });
    }
  });

  app.delete('/api/admin/resenas/:id', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const resenaId = parseResenaId(req.params.id);
      if (!resenaId) {
        return res.status(400).json({ error: 'ID de reseña inválido' });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      if (role.rol !== 'super_admin') {
        return res.status(403).json({ error: 'Solo super_admin puede eliminar reseñas' });
      }

      const deleted = await deleteResenaPg(pgPool, resenaId);
      if (!deleted) {
        return res.status(404).json({ error: 'Reseña no encontrada' });
      }

      res.json({ ok: true, id: resenaId });
    } catch (err) {
      console.error('❌ DELETE /api/admin/resenas/:id:', err.message);
      res.status(500).json({ error: err.message || 'Error al eliminar reseña' });
    }
  });
}
