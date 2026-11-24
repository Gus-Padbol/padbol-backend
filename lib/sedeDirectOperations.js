// Bounded durable adapter for the keyed direct-seat alta.
// No scheduler, queue, coordinator or provider retry. Only PG short transactions.
import crypto from 'node:crypto';

export const DIRECT_OPERATION_VERSION = 1;
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SAFE_RECEIPT_KEYS = ['ok', 'sede_id', 'auth_user_created', 'access_state', 'welcome_delivery'];

export const directError = (code, message, status = 500, extra = {}) =>
  Object.assign(new Error(message), { code, status, ...extra });

export const normalizeOperationKey = (value) => {
  const key = String(value ?? '').trim().toLowerCase();
  return KEY_RE.test(key) ? key : null;
};

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
};

// Digest of the exact normalized write effects (including transient payment
// config) so a changed body under the same key is rejected before Auth.
export function directOperationDigest(parts = {}) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stable({ canonical_version: DIRECT_OPERATION_VERSION, ...parts })))
    .digest('hex');
}

export const isDirectDbUnavailable = (error) => {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (['42P01','42883','3F000','42501','57P01','57P02','57P03','08000','08001','08003','08006','53300','ECONNREFUSED','ETIMEDOUT','ENOTFOUND'].includes(code)) return true;
  return /relation .*sede_direct_operations.* does not exist/i.test(message)
    || /function .*sede_direct_/i.test(message) && /does not exist/i.test(message);
};

const ROW_COLUMNS = 'actor_id, operation_key, payload_digest, canonical_version, state, sede_id, receipt, created_at, updated_at';
const rowView = (row) => row ? {
  actor_id: row.actor_id,
  operation_key: row.operation_key,
  payload_digest: row.payload_digest,
  canonical_version: Number(row.canonical_version),
  state: row.state,
  sede_id: row.sede_id == null ? null : Number(row.sede_id),
  receipt: row.receipt || null,
  created_at: row.created_at,
  updated_at: row.updated_at,
} : null;

async function withTx(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw error;
  } finally {
    client.release();
  }
}

async function lockSuperAdmin(client, actorId) {
  const { rows } = await client.query(
    "select id, role from public.user_roles where user_id=$1 for share",
    [actorId],
  );
  if (rows.length !== 1 || rows[0].role !== 'super_admin') throw directError('DIRECT_OPERATION_FORBIDDEN', 'Solo super admin puede operar el alta directa.', 403);
}

async function lockTargetRoleRows(client, licEmail) {
  const { rows } = await client.query(
    "select id, user_id, email from public.user_roles where lower(btrim(coalesce(email,''))) = lower(btrim($1)) order by id for update",
    [licEmail],
  );
  return rows;
}

function assertActorInvariant({ actorId, actorEmail, licEmail, rows }) {
  if (rows.length > 1) {
    throw directError('DIRECT_OPERATION_ROLE_AMBIGUOUS', 'El email del licenciatario tiene más de una asignación.', 409);
  }
  const normalizedActor = String(actorEmail || '').trim().toLowerCase();
  if (normalizedActor && normalizedActor === String(licEmail || '').trim().toLowerCase()) {
    throw directError('DIRECT_ACTOR_ROLE_CONFLICT', 'El licenciatario no puede ser el SuperAdmin que opera el alta.', 409);
  }
  if (rows.some((row) => String(row.user_id || '') === String(actorId))) {
    throw directError('DIRECT_ACTOR_ROLE_CONFLICT', 'El licenciatario no puede ser el SuperAdmin que opera el alta.', 409);
  }
}

export async function requireDirectSuperAdmin(pool, actorId) {
  const client = await pool.connect();
  try { await lockSuperAdmin(client, actorId); return true; }
  finally { client.release(); }
}

export async function preflightDirectRoleTarget(pool, { actorId, actorEmail, licEmail }) {
  return withTx(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended('invitacion_admin_club:'||lower(btrim($1)),0))", [licEmail]);
    const rows = await lockTargetRoleRows(client, licEmail);
    assertActorInvariant({ actorId, actorEmail, licEmail, rows });
    return rows.length;
  });
}

export async function prepareDirectOperation(pool, { actorId, actorEmail, operationKey, payloadDigest }) {
  return withTx(pool, async (client) => {
    await lockSuperAdmin(client, actorId);
    await client.query(
      `insert into public.sede_direct_operations(actor_id, operation_key, payload_digest, canonical_version, state)
       values($1,$2,$3,$4,'prepared') on conflict (actor_id, operation_key) do nothing`,
      [actorId, operationKey, payloadDigest, DIRECT_OPERATION_VERSION],
    );
    const { rows } = await client.query(
      `select ${ROW_COLUMNS} from public.sede_direct_operations where actor_id=$1 and operation_key=$2 for update`,
      [actorId, operationKey],
    );
    const row = rowView(rows[0]);
    if (!row) throw directError('DIRECT_OPERATION_STORE_ERROR', 'No se pudo preparar la operación.', 503);
    if (row.state === 'cancelled') throw directError('DIRECT_OPERATION_CANCELLED', 'La operación fue cancelada.', 409);
    if (row.canonical_version !== DIRECT_OPERATION_VERSION || row.payload_digest !== payloadDigest) {
      throw directError('DIRECT_OPERATION_DIGEST_MISMATCH', 'La clave ya se usó con otro contenido.', 409);
    }
    if (row.state === 'completed') return { state: 'completed', replayed: true, operation: row };
    return { state: 'prepared', replayed: false, operation: row };
  });
}

export async function readDirectOperation(pool, { actorId, operationKey }) {
  return withTx(pool, async (client) => {
    await lockSuperAdmin(client, actorId);
    const { rows } = await client.query(
      `select ${ROW_COLUMNS} from public.sede_direct_operations where actor_id=$1 and operation_key=$2 for update`,
      [actorId, operationKey],
    );
    return rowView(rows[0]);
  });
}

export async function cancelDirectOperation(pool, { actorId, actorEmail, operationKey }) {
  return withTx(pool, async (client) => {
    await lockSuperAdmin(client, actorId);
    const { rows } = await client.query(
      `select ${ROW_COLUMNS} from public.sede_direct_operations where actor_id=$1 and operation_key=$2 for update`,
      [actorId, operationKey],
    );
    const row = rowView(rows[0]);
    if (!row) {
      const inserted = await client.query(
        `insert into public.sede_direct_operations(actor_id, operation_key, payload_digest, canonical_version, state)
         values($1,$2,NULL,NULL,'cancelled') on conflict (actor_id, operation_key) do nothing returning ${ROW_COLUMNS}`,
        [actorId, operationKey],
      );
      if (inserted.rowCount === 1) return { state: 'cancelled', replayed: false, operation: rowView(inserted.rows[0]) };
      const again = await client.query(`select ${ROW_COLUMNS} from public.sede_direct_operations where actor_id=$1 and operation_key=$2 for update`, [actorId, operationKey]);
      return { state: 'cancelled', replayed: true, operation: rowView(again.rows[0]) };
    }
    if (row.state === 'completed') return { state: 'completed', replayed: true, operation: row };
    if (row.state === 'cancelled') return { state: 'cancelled', replayed: true, operation: row };
    const updated = await client.query(
      "update public.sede_direct_operations set state='cancelled', updated_at=now() where actor_id=$1 and operation_key=$2 and state='prepared' returning " + ROW_COLUMNS,
      [actorId, operationKey],
    );
    return { state: 'cancelled', replayed: false, operation: rowView(updated.rows[0]) };
  });
}

function safeReceipt(input) {
  const out = {};
  for (const key of SAFE_RECEIPT_KEYS) if (input && input[key] !== undefined) out[key] = input[key];
  return out;
}

export async function commitDirectSeat(pool, {
  actorId, actorEmail, operationKey, payloadDigest, sedeInsert, licEmail, licNombre,
  assignment, organizacionId, authReceipt,
}) {
  return withTx(pool, async (client) => {
    await lockSuperAdmin(client, actorId);
    const opResult = await client.query(
      `select ${ROW_COLUMNS} from public.sede_direct_operations where actor_id=$1 and operation_key=$2 for update`,
      [actorId, operationKey],
    );
    const operation = rowView(opResult.rows[0]);
    if (!operation) throw directError('DIRECT_OPERATION_NOT_FOUND', 'Operación no encontrada.', 404);
    if (operation.canonical_version !== DIRECT_OPERATION_VERSION || operation.payload_digest !== payloadDigest) {
      throw directError('DIRECT_OPERATION_DIGEST_MISMATCH', 'La clave ya se usó con otro contenido.', 409);
    }
    if (operation.state === 'completed') return { replayed: true, sedeId: operation.sede_id, receipt: operation.receipt };
    if (operation.state === 'cancelled') throw directError('DIRECT_OPERATION_CANCELLED', 'La operación fue cancelada.', 409);

    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('invitacion_admin_club:'||lower(btrim($1)),0))",
      [licEmail],
    );
    const targetRows = await lockTargetRoleRows(client, licEmail);
    assertActorInvariant({ actorId, actorEmail, licEmail, rows: targetRows });

    const columns = Object.keys(sedeInsert || {});
    if (!columns.length) throw directError('DIRECT_OPERATION_WRITE_INVALID', 'Alta sin columnas de sede.', 400);
    const quoted = columns.map((column) => `"${String(column).replaceAll('"', '""')}"`).join(',');
    const sede = await client.query(
      `insert into public.sedes (${quoted}) select ${quoted} from jsonb_populate_record(NULL::public.sedes, $1::jsonb) returning id`,
      [JSON.stringify(sedeInsert)],
    );
    const sedeId = Number(sede.rows[0]?.id);
    if (!Number.isSafeInteger(sedeId) || sedeId <= 0) throw directError('DIRECT_OPERATION_WRITE_INVALID', 'La sede no se pudo confirmar.', 500);

    if (organizacionId) {
      const link = await client.query(
        'insert into public.organizacion_sedes(organizacion_id, sede_id) values($1,$2)',
        [organizacionId, sedeId],
      );
      if (link.rowCount !== 1) throw directError('DIRECT_OPERATION_WRITE_INVALID', 'El vínculo de organización no se pudo confirmar.', 500);
    }

    const roleRow = {
      role: assignment.role,
      alcance: assignment.alcance,
      nombre: String(licNombre || '').trim() || null,
      sede_id: assignment.alcance === 'sede' ? sedeId : null,
      ciudad: assignment.ciudad ?? null,
      provincia: assignment.provincia ?? null,
      pais: assignment.pais ?? null,
      torneos_oficiales_habilitados: assignment.role === 'admin_nacional',
    };
    let written;
    if (targetRows.length === 1) {
      written = await client.query(
        `update public.user_roles set role=$2, alcance=$3, nombre=$4, sede_id=$5, ciudad=$6, provincia=$7, pais=$8,
           torneos_oficiales_habilitados=$9 where id=$1`,
        [targetRows[0].id, roleRow.role, roleRow.alcance, roleRow.nombre, roleRow.sede_id, roleRow.ciudad, roleRow.provincia, roleRow.pais, roleRow.torneos_oficiales_habilitados],
      );
    } else {
      written = await client.query(
        `insert into public.user_roles(email, role, alcance, nombre, sede_id, ciudad, provincia, pais, torneos_oficiales_habilitados)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [licEmail, roleRow.role, roleRow.alcance, roleRow.nombre, roleRow.sede_id, roleRow.ciudad, roleRow.provincia, roleRow.pais, roleRow.torneos_oficiales_habilitados],
      );
    }
    if (written.rowCount !== 1) throw directError('DIRECT_OPERATION_WRITE_INVALID', 'El rol del licenciatario no se pudo confirmar.', 500);

    const receipt = safeReceipt({
      ok: true,
      sede_id: sedeId,
      auth_user_created: Boolean(authReceipt?.auth_user_created),
      access_state: authReceipt?.access_state ?? null,
      welcome_delivery: authReceipt?.welcome_delivery ?? null,
    });
    const done = await client.query(
      `update public.sede_direct_operations set state='completed', sede_id=$3, receipt=$4::jsonb, updated_at=now()
       where actor_id=$1 and operation_key=$2 and state='prepared' returning ${ROW_COLUMNS}`,
      [actorId, operationKey, sedeId, JSON.stringify(receipt)],
    );
    if (done.rowCount !== 1) throw directError('DIRECT_OPERATION_WRITE_INVALID', 'La operación no se pudo confirmar.', 500);
    return { replayed: false, sedeId, receipt };
  });
}
