const RESENAS_TABLE = 'resenas';
const LIST_LIMIT = 50;

const SCHEMA_DIAGNOSTIC_SQL = `
  SELECT column_name
  FROM information_schema.columns
  WHERE table_name = 'resenas'
  ORDER BY ordinal_position
`;

let resenasSchemaCache = null;
let resenasSchemaLoadPromise = null;

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

function pickFirstColumn(columns, candidates) {
  for (const name of candidates) {
    if (columns.includes(name)) return name;
  }
  return null;
}

function buildResenasSchema(columnNames) {
  const columns = [...new Set(columnNames.filter(Boolean))];
  const has = (name) => columns.includes(name);

  return {
    columns,
    has,
    ratingCol: pickFirstColumn(columns, ['estrellas', 'puntuacion']),
    respuestaCol: pickFirstColumn(columns, ['respuesta', 'respuesta_admin']),
    respuestaAtCol: pickFirstColumn(columns, ['fecha_respuesta', 'respuesta_at']),
    respuestaPorCol: has('respuesta_por') ? 'respuesta_por' : null,
    nombreCol: has('nombre') ? 'nombre' : null,
    reservaIdCol: has('reserva_id') ? 'reserva_id' : null,
  };
}

async function loadResenasSchema(pgPool) {
  if (resenasSchemaCache) return resenasSchemaCache;
  if (!resenasSchemaLoadPromise) {
    resenasSchemaLoadPromise = (async () => {
      const { rows } = await pgPool.query(SCHEMA_DIAGNOSTIC_SQL);
      const loggedColumns = rows.map((row) => row.column_name);
      console.log('[RESEÑAS-SCHEMA] information_schema.columns (table_name = resenas):', loggedColumns);

      const { rows: publicRows } = await pgPool.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [RESENAS_TABLE],
      );
      const publicColumns = publicRows.map((row) => row.column_name);
      const columnNames = publicColumns.length > 0 ? publicColumns : loggedColumns;

      if (!columnNames.length) {
        throw new Error('Tabla resenas no encontrada o sin columnas en information_schema');
      }

      resenasSchemaCache = buildResenasSchema(columnNames);
      console.log('[RESEÑAS-SCHEMA] columnas usadas en queries:', resenasSchemaCache.columns);
      return resenasSchemaCache;
    })();
  }
  return resenasSchemaLoadPromise;
}

async function ensureResenasSchema(pgPool) {
  return loadResenasSchema(pgPool);
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

function mapResenaRow(row, schema) {
  if (!row) return null;
  const respuestaRaw = schema.respuestaCol ? row.respuesta ?? row[schema.respuestaCol] : null;
  const respuestaAtRaw = schema.respuestaAtCol
    ? row.respuesta_at ?? row[schema.respuestaAtCol]
    : null;

  return {
    id: row.id,
    sede_id: row.sede_id,
    user_id: row.user_id,
    reserva_id: schema.reservaIdCol ? (row.reserva_id ?? row[schema.reservaIdCol] ?? null) : null,
    puntuacion: Number(row.puntuacion ?? (schema.ratingCol ? row[schema.ratingCol] : null) ?? 0),
    comentario: row.comentario ?? '',
    created_at: row.created_at ?? null,
    respuesta_admin: respuestaRaw ?? null,
    respuesta_at: respuestaAtRaw ?? null,
    respuesta_por: schema.respuestaPorCol ? (row.respuesta_por ?? row[schema.respuestaPorCol] ?? null) : null,
    display_name: row.display_name ?? 'Usuario',
    foto_url: row.foto_url ?? null,
  };
}

function buildDisplayNameSql(schema) {
  const parts = [
    "NULLIF(TRIM(jp.apodo), '')",
    "NULLIF(TRIM(CONCAT(COALESCE(jp.nombre, ''), ' ', COALESCE(jp.apellido, ''))), '')",
  ];
  if (schema.nombreCol) {
    parts.push(`NULLIF(TRIM(r.${schema.nombreCol}), '')`);
  }
  parts.push("'Usuario'");
  return `COALESCE(${parts.join(', ')}) AS display_name`;
}

function buildSelectSql(schema) {
  const selectParts = [
    'r.id',
    'r.sede_id',
    'r.user_id',
  ];

  if (schema.ratingCol) {
    selectParts.push(`r.${schema.ratingCol} AS puntuacion`);
  } else {
    selectParts.push('NULL::int AS puntuacion');
  }

  if (schema.has('comentario')) selectParts.push('r.comentario');
  if (schema.has('created_at')) selectParts.push('r.created_at');

  if (schema.respuestaCol) {
    selectParts.push(`r.${schema.respuestaCol} AS respuesta`);
  }

  if (schema.respuestaAtCol) {
    selectParts.push(`r.${schema.respuestaAtCol} AS respuesta_at`);
  }

  if (schema.respuestaPorCol) {
    selectParts.push(`r.${schema.respuestaPorCol}`);
  }

  if (schema.reservaIdCol) {
    selectParts.push(`r.${schema.reservaIdCol}`);
  }

  selectParts.push(buildDisplayNameSql(schema));
  selectParts.push('jp.foto_url');

  return `
    SELECT
      ${selectParts.join(',\n      ')}
    FROM ${RESENAS_TABLE} r
    LEFT JOIN jugadores_perfil jp ON jp.user_id = r.user_id
  `;
}

function buildReturningSql(schema) {
  const parts = ['id', 'sede_id', 'user_id'];

  if (schema.ratingCol) {
    parts.push(`${schema.ratingCol} AS puntuacion`);
  }

  if (schema.has('comentario')) parts.push('comentario');
  if (schema.has('created_at')) parts.push('created_at');

  if (schema.respuestaCol) {
    parts.push(`${schema.respuestaCol} AS respuesta`);
  }

  if (schema.respuestaAtCol) {
    parts.push(`${schema.respuestaAtCol} AS respuesta_at`);
  }

  if (schema.respuestaPorCol) parts.push(schema.respuestaPorCol);
  if (schema.nombreCol) parts.push(schema.nombreCol);

  return parts.join(', ');
}

function requireColumns(schema, names, context) {
  const missing = names.filter((name) => !schema.has(name));
  if (missing.length) {
    throw new Error(`${context}: faltan columnas en ${RESENAS_TABLE}: ${missing.join(', ')}`);
  }
}

async function sedeExistsPg(pgPool, sedeId) {
  const { rows } = await pgPool.query('SELECT id FROM sedes WHERE id = $1 LIMIT 1', [sedeId]);
  return Boolean(rows[0]);
}

async function fetchResenasStatsPg(pgPool, schema, sedeId) {
  requireColumns(schema, ['sede_id'], 'fetchResenasStatsPg');

  const avgExpr = schema.ratingCol
    ? `ROUND(AVG(${schema.ratingCol}::numeric), 1)`
    : 'NULL::numeric';

  const { rows } = await pgPool.query(
    `SELECT
       COUNT(*)::int AS total,
       ${avgExpr} AS promedio
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

async function userHasResenaPg(pgPool, schema, { sedeId, userId }) {
  requireColumns(schema, ['sede_id', 'user_id'], 'userHasResenaPg');

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

async function insertResenaPg(pgPool, schema, { sedeId, userId, puntuacion, comentario }) {
  requireColumns(schema, ['sede_id', 'user_id'], 'insertResenaPg');
  if (!schema.ratingCol) {
    throw new Error('insertResenaPg: la tabla resenas no tiene columna estrellas ni puntuacion');
  }

  const comentarioVal = comentario != null && String(comentario).trim() !== ''
    ? String(comentario).trim().slice(0, 500)
    : null;

  const insertCols = ['sede_id', 'user_id', schema.ratingCol];
  const values = ['$1', '$2::uuid', '$3'];
  const params = [sedeId, userId, puntuacion];

  if (schema.has('comentario')) {
    insertCols.push('comentario');
    values.push(`$${params.length + 1}`);
    params.push(comentarioVal);
  }

  if (schema.nombreCol) {
    const nombreAutor = await fetchNombreAutorPg(pgPool, userId);
    insertCols.push(schema.nombreCol);
    values.push(`$${params.length + 1}`);
    params.push(nombreAutor);
  }

  const { rows } = await pgPool.query(
    `INSERT INTO ${RESENAS_TABLE} (${insertCols.join(', ')})
     VALUES (${values.join(', ')})
     RETURNING ${buildReturningSql(schema)}`,
    params,
  );
  return rows[0];
}

async function fetchResenaByIdPg(pgPool, schema, resenaId) {
  requireColumns(schema, ['id'], 'fetchResenaByIdPg');
  const { rows } = await pgPool.query(
    `${buildSelectSql(schema)} WHERE r.id = $1::uuid LIMIT 1`,
    [resenaId],
  );
  return rows[0] ?? null;
}

async function updateResenaRespuestaPg(pgPool, schema, { resenaId, respuestaAdmin, respuestaPor }) {
  requireColumns(schema, ['id'], 'updateResenaRespuestaPg');
  if (!schema.respuestaCol) {
    throw new Error('updateResenaRespuestaPg: la tabla resenas no tiene columna respuesta ni respuesta_admin');
  }

  const text = String(respuestaAdmin ?? '').trim();
  const setParts = [`${schema.respuestaCol} = $1`];
  const params = [text || null];

  if (schema.respuestaAtCol) {
    setParts.push(`${schema.respuestaAtCol} = NOW()`);
  }

  if (schema.respuestaPorCol && respuestaPor) {
    params.push(respuestaPor);
    setParts.push(`${schema.respuestaPorCol} = $${params.length}::uuid`);
  }

  params.push(resenaId);

  const { rows } = await pgPool.query(
    `UPDATE ${RESENAS_TABLE}
     SET ${setParts.join(', ')}
     WHERE id = $${params.length}::uuid
     RETURNING ${buildReturningSql(schema)}`,
    params,
  );
  return rows[0] ?? null;
}

async function deleteResenaPg(pgPool, schema, resenaId) {
  requireColumns(schema, ['id'], 'deleteResenaPg');
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

      const schema = await ensureResenasSchema(pgPool);
      requireColumns(schema, ['sede_id', 'created_at'], 'GET /api/sedes/:id/resenas');

      const sedeId = parseSedeId(req.params.id);
      if (sedeId == null) {
        return res.status(400).json({ error: 'ID de sede inválido' });
      }

      if (!(await sedeExistsPg(pgPool, sedeId))) {
        return res.status(404).json({ error: 'Sede no encontrada' });
      }

      const { rows } = await pgPool.query(
        `${buildSelectSql(schema)}
         WHERE r.sede_id = $1
         ORDER BY r.created_at DESC
         LIMIT ${LIST_LIMIT}`,
        [sedeId],
      );

      const stats = await fetchResenasStatsPg(pgPool, schema, sedeId);
      const resenas = rows.map((row) => mapResenaRow(row, schema));

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

      const schema = await ensureResenasSchema(pgPool);

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

      const duplicate = await userHasResenaPg(pgPool, schema, {
        sedeId,
        userId: user.id,
      });
      if (duplicate) {
        return res.status(409).json({ error: 'Ya reseñaste esta sede' });
      }

      const inserted = await insertResenaPg(pgPool, schema, {
        sedeId,
        userId: user.id,
        puntuacion,
        comentario,
      });

      const enriched = inserted?.id
        ? await fetchResenaByIdPg(pgPool, schema, inserted.id)
        : inserted;

      res.status(201).json({ resena: mapResenaRow(enriched ?? inserted, schema) });
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

      const schema = await ensureResenasSchema(pgPool);

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const resenaId = parseResenaId(req.params.id);
      if (!resenaId) {
        return res.status(400).json({ error: 'ID de reseña inválido' });
      }

      const existing = await fetchResenaByIdPg(pgPool, schema, resenaId);
      if (!existing) {
        return res.status(404).json({ error: 'Reseña no encontrada' });
      }

      const role = await resolveAuthRole(user, { fetchUserRoleRowForAuthUser, legacySuperAdminEmails });
      if (!canRespondToResena(role, existing.sede_id)) {
        return res.status(403).json({ error: 'No tenés permiso para responder esta reseña' });
      }

      const respuestaTexto = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'respuesta')
        ? req.body.respuesta
        : req.body?.respuesta_admin;

      if (respuestaTexto == null || String(respuestaTexto).trim() === '') {
        return res.status(400).json({ error: 'respuesta es requerido' });
      }

      const updated = await updateResenaRespuestaPg(pgPool, schema, {
        resenaId,
        respuestaAdmin: respuestaTexto,
        respuestaPor: schema.respuestaPorCol ? user.id : null,
      });
      if (!updated) {
        return res.status(404).json({ error: 'Reseña no encontrada' });
      }

      const enriched = await fetchResenaByIdPg(pgPool, schema, resenaId);
      res.json({ resena: mapResenaRow(enriched ?? updated, schema) });
    } catch (err) {
      console.error('❌ PATCH /api/admin/resenas/:id/respuesta:', err.message);
      res.status(500).json({ error: err.message || 'Error al actualizar respuesta' });
    }
  });

  app.delete('/api/admin/resenas/:id', async (req, res) => {
    try {
      if (!pgPool) return pgUnavailable(res);

      const schema = await ensureResenasSchema(pgPool);

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

      const deleted = await deleteResenaPg(pgPool, schema, resenaId);
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
