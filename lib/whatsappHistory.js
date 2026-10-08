// Read-only history: no dependency on the sender, webhook or legacy role-claim flow.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const stamp = (column) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const itemColumns = `i.id, i.channel_id, ${stamp('i.received_at')} as received_at,
  '••••' || right(i.from_wa_id, 4) as contact_label`;

export function parseHistoryPage(query, tenantId) {
  if (Object.keys(query).some(key => !['limit', 'before'].includes(key))) throw fail(400, 'INVALID_PAGE');
  const limit = query.limit == null ? 25 : Number(query.limit);
  if ((query.limit != null && (typeof query.limit !== 'string' || !/^\d{1,2}$/.test(query.limit)))
    || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail(400, 'INVALID_PAGE');
  if (query.before == null) return { limit, before: null };
  try {
    if (typeof query.before !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(query.before)) throw new Error();
    const value = JSON.parse(Buffer.from(query.before, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== tenantId
      || !ISO.test(value[2]) || !Number.isFinite(Date.parse(value[2]))
      || new Date(value[2]).toISOString().slice(0, 19) !== value[2].slice(0, 19)
      || !UUID.test(value[3])) throw new Error();
    return { limit, before: { at: value[2], id: value[3] } };
  } catch { throw fail(400, 'INVALID_PAGE'); }
}

const cursorFor = (tenantId, row) => Buffer.from(JSON.stringify([1, tenantId, row.received_at, row.id])).toString('base64url');
const itemDto = row => ({ id: row.id, channelId: row.channel_id, receivedAt: row.received_at,
  contactLabel: row.contact_label, responseStatus: row.response_status || 'none' });
const tenantDto = row => ({ id: row.id, name: row.display_name, channelStatus: row.status,
  scope: row.organization_id ? { type: 'organization', id: row.organization_id } : { type: 'venue', id: String(row.sede_id) } });

async function loadRole(db, userId) {
  // Deliberately no email lookup or UPDATE: reading history never claims a legacy role.
  const { rows } = await db.query(`select role, alcance, sede_id, organizacion_id from public.user_roles
    where user_id = $1::uuid limit 2`, [userId]);
  if (rows.length !== 1) throw fail(403, 'HISTORY_FORBIDDEN');
  const role = rows[0];
  if (role.role === 'admin_club' && (!role.alcance || role.alcance === 'sede') && role.sede_id != null) return role;
  if (role.role === 'admin_cadena' && role.alcance === 'organizacion' && role.organizacion_id) return role;
  throw fail(403, 'HISTORY_FORBIDDEN');
}

async function authorizedTenants(db, role, tenantId = null) {
  // Channel status concerns delivery only. Organization/venue status remains an access boundary.
  const { rows } = await db.query(`select t.id, t.display_name, t.status, t.organization_id, t.sede_id
    from public.whatsapp_tenants t
    where t.inbox_enabled = true and ($4::uuid is null or t.id = $4::uuid) and (
      ($1 = 'admin_club' and t.sede_id = $2::bigint and exists (
        select 1 from public.sedes s where s.id = t.sede_id and s.estado = 'activo'))
      or ($1 = 'admin_cadena' and exists (
        select 1 from public.organizaciones o where o.id = $3::uuid and o.estado = 'activa'
          and (t.organization_id = o.id or exists (
            select 1 from public.organizacion_sedes os join public.sedes s on s.id = os.sede_id
            where os.organizacion_id = o.id and os.sede_id = t.sede_id and s.estado = 'activo'))))
    ) order by t.id limit 101`, [role.role, role.sede_id, role.organizacion_id, tenantId]);
  if (rows.length > 100) throw fail(503, 'HISTORY_UNAVAILABLE');
  return rows;
}

async function audit(db, actor, tenant, resource, action) {
  await db.query(`insert into public.whatsapp_history_access_audit
    (actor_user_id, tenant_id, resource_id, action) values ($1::uuid, $2::uuid, $3::uuid, $4)`,
  [actor, tenant, resource, action]);
}

export function createWhatsappHistoryService({ pgPool }) {
  async function withScope(userId, tenantId, operation) {
    if (!UUID.test(userId || '')) throw fail(401, 'AUTH_REQUIRED');
    if (tenantId != null && !UUID.test(tenantId)) throw fail(404, 'HISTORY_NOT_FOUND');
    if (!pgPool) throw fail(503, 'HISTORY_UNAVAILABLE');
    const db = await pgPool.connect();
    try {
      // One authorization snapshot per request; no stale cross-request permission cache.
      await db.query('begin isolation level repeatable read');
      await db.query("set local statement_timeout = '5000ms'");
      const role = await loadRole(db, userId);
      const tenants = await authorizedTenants(db, role, tenantId);
      if (tenantId && !tenants.length) throw fail(404, 'HISTORY_NOT_FOUND');
      const result = await operation(db, tenants);
      await db.query('commit');
      return result;
    } catch (error) {
      await db.query('rollback').catch(() => {});
      throw error;
    } finally { db.release(); }
  }
  return {
    listTenants: (userId) => withScope(userId, null, async (db, tenants) => {
      await audit(db, userId, null, null, 'list_tenants');
      return { tenants: tenants.map(tenantDto) };
    }),
    listHistory: (userId, tenantId, query = {}) => withScope(userId, tenantId, async (db) => {
      const { limit, before } = parseHistoryPage(query, tenantId);
      if (before) {
        const anchor = await db.query(`select id from public.whatsapp_inbound_messages
          where tenant_id = $1::uuid and id = $2::uuid and received_at = $3::timestamptz`, [tenantId, before.id, before.at]);
        if (!anchor.rows.length) throw fail(400, 'INVALID_PAGE');
      }
      const { rows } = await db.query(`select ${itemColumns}, (
        select o.status from public.whatsapp_outbox o where o.tenant_id = i.tenant_id
          and o.channel_id = i.channel_id and o.inbound_message_id = i.id
          order by o.created_at desc, o.id desc limit 1) as response_status
        from public.whatsapp_inbound_messages i where i.tenant_id = $1::uuid
          and ($2::timestamptz is null or (i.received_at, i.id) < ($2::timestamptz, $3::uuid))
        order by i.received_at desc, i.id desc limit $4`, [tenantId, before?.at || null, before?.id || null, limit + 1]);
      const page = rows.slice(0, limit);
      await audit(db, userId, tenantId, tenantId, 'list_history');
      return { items: page.map(itemDto), nextCursor: rows.length > limit ? cursorFor(tenantId, page[page.length - 1]) : null };
    }),
    readExchange: (userId, tenantId, inboundId) => withScope(userId, tenantId, async (db) => {
      if (!UUID.test(inboundId || '')) throw fail(404, 'HISTORY_NOT_FOUND');
      const { rows } = await db.query(`select ${itemColumns}, i.text_body from public.whatsapp_inbound_messages i
        where i.tenant_id = $1::uuid and i.id = $2::uuid`, [tenantId, inboundId]);
      if (!rows.length) throw fail(404, 'HISTORY_NOT_FOUND');
      const inbound = rows[0];
      const outbound = await db.query(`select id, text_body, status, ${stamp('created_at')} as created_at,
        ${stamp('sent_at')} as sent_at from public.whatsapp_outbox
        where tenant_id = $1::uuid and channel_id = $2::uuid and inbound_message_id = $3::uuid
        order by created_at, id limit 101`, [tenantId, inbound.channel_id, inboundId]);
      if (outbound.rows.length > 100) throw fail(503, 'HISTORY_UNAVAILABLE');
      await audit(db, userId, tenantId, inboundId, 'read_exchange');
      return { exchange: { ...itemDto({ ...inbound, response_status: outbound.rows.at(-1)?.status }), text: inbound.text_body,
        responses: outbound.rows.map(row => ({ id: row.id, text: row.text_body, status: row.status,
          createdAt: row.created_at, acceptedAt: row.sent_at })) } };
    }),
  };
}

export function registerWhatsappHistoryRoutes(app, { pgPool, authUserFromBearer }) {
  const service = createWhatsappHistoryService({ pgPool });
  const route = operation => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Authorization');
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id) throw fail(401, 'AUTH_REQUIRED');
      return res.json(await operation(user.id, req));
    } catch (error) {
      const known = ['AUTH_REQUIRED', 'HISTORY_FORBIDDEN', 'HISTORY_NOT_FOUND', 'INVALID_PAGE'].includes(error.code);
      const code = known ? error.code : 'HISTORY_UNAVAILABLE';
      const messages = { AUTH_REQUIRED: 'Inicia sesión para continuar.', HISTORY_FORBIDDEN: 'No tienes acceso a este historial.',
        HISTORY_NOT_FOUND: 'Historial no disponible.', INVALID_PAGE: 'Página inválida.', HISTORY_UNAVAILABLE: 'No se pudo consultar el historial.' };
      return res.status(known ? error.status : 503).json({ code, error: messages[code] });
    }
  };
  app.get('/api/admin/whatsapp/tenants', route(user => service.listTenants(user)));
  app.get('/api/admin/whatsapp/tenants/:tenantId/history', route((user, req) => service.listHistory(user, req.params.tenantId, req.query)));
  app.get('/api/admin/whatsapp/tenants/:tenantId/history/:inboundId', route((user, req) => service.readExchange(user, req.params.tenantId, req.params.inboundId)));
}
