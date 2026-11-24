import express from 'express';
import { requireAdminUser, requireSuperAdminUser, resolveAuthRoleForUser } from '../lib/authAccess.js';

const BUCKET = 'content-workspace-private';
const CATEGORY = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MIME = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime))$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEDE = (v) => typeof v === 'string' || typeof v === 'number'
  ? (/^[1-9]\d*$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null)
  : null;
const fail = (res, status, message) => res.status(status).json({ error: message });

export function createContentLibraryRouter(deps) {
  const router = express.Router();
  const query = (text, params = []) => deps.pgPool.query(text, params);
  const authDeps = {
    getAuthenticatedUser: deps.getAuthenticatedUser,
    fetchUserRoleRowForAuthUser: deps.fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails: deps.legacySuperAdminEmails || [],
  };
  const admin = (req, res) => requireAdminUser(req, res, authDeps);
  const superAdmin = (req, res) => requireSuperAdminUser(req, res, authDeps);
  const scopeFor = (req, role) => {
    if (role.rol === 'super_admin') return SEDE(req.query.sede_id ?? req.body?.sede_id);
    return role.rol === 'admin_club' && Number.isSafeInteger(role.sede_id) && role.sede_id > 0 ? role.sede_id : null;
  };
  const dto = (row) => ({
    id: row.id, title: row.title, category: row.category_key, format: row.format || null,
    assetKind: row.asset_kind || null, mime: row.mime_type, sourceVersion: Number(row.source_version),
  });
  async function visibleEntry(entryId, sedeId) {
    const { rows } = await query(`select e.id,e.category_key,e.item_id,e.file_id,e.source_version,
      i.payload->>'title' title,i.payload->>'format' format,i.payload->>'assetKind' asset_kind,
      f.mime_type,f.storage_path
      from public.content_library_entries e
      join public.content_library_categories c on c.sede_id=e.sede_id and c.category_key=e.category_key and c.enabled
      join public.content_workspace_items i on i.id=e.item_id and i.version=e.source_version
      join public.content_workspace_files f on f.id=e.file_id and f.item_id=i.id
      where e.id=$1 and e.sede_id=$2 and i.payload->>'status' in ('aprobado','publicado')`, [entryId, sedeId]);
    return rows[0] || null;
  }
  async function list(req, res) {
    try {
      const auth = await admin(req, res); if (!auth) return;
      const sedeId = scopeFor(req, auth.role);
      if (!sedeId) return fail(res, 403, 'No tenés permiso para esta sede');
      if (auth.role.rol !== 'super_admin' && req.query.sede_id != null && Number(req.query.sede_id) !== sedeId) return fail(res, 403, 'No tenés permiso para esta sede');
      const { rows } = await query(`select e.id,e.category_key,e.source_version,
        i.payload->>'title' title,i.payload->>'format' format,i.payload->>'assetKind' asset_kind,f.mime_type
        from public.content_library_entries e
        join public.content_library_categories c on c.sede_id=e.sede_id and c.category_key=e.category_key and c.enabled
        join public.content_workspace_items i on i.id=e.item_id and i.version=e.source_version
        join public.content_workspace_files f on f.id=e.file_id and f.item_id=i.id
        where e.sede_id=$1 and i.payload->>'status' in ('aprobado','publicado')
        order by e.updated_at desc,e.id limit 50`, [sedeId]);
      return res.json({ items: rows.map(dto) });
    } catch { return fail(res, 503, 'No se pudo cargar la biblioteca'); }
  }
  router.get('/', list);
  router.post('/categories', async (req, res) => {
    try {
      const auth = await superAdmin(req, res); if (!auth) return;
      const sedeId = SEDE(req.body?.sede_id); const key = String(req.body?.category_key || '').trim().toLowerCase();
      if (!sedeId || !CATEGORY.test(key) || typeof req.body?.enabled !== 'boolean') return fail(res, 400, 'Revisá sede, categoría y estado');
      const { rows } = await query(`insert into public.content_library_categories(sede_id,category_key,enabled,updated_by)
        values($1,$2,$3,$4) on conflict(sede_id,category_key) do update set enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=now()
        returning sede_id,category_key,enabled`, [sedeId, key, req.body.enabled, auth.user.id]);
      return res.json({ category: rows[0] });
    } catch { return fail(res, 503, 'No se pudo guardar la categoría'); }
  });
  router.post('/entries', async (req, res) => {
    let client = null;
    try {
      const auth = await superAdmin(req, res); if (!auth) return;
      client = deps.pgPool ? await deps.pgPool.connect() : null;
      if (!client) return fail(res, 503, 'Base de datos no disponible');
      const sedeId = SEDE(req.body?.sede_id); const itemId = String(req.body?.item_id || '');
      const fileId = String(req.body?.file_id || ''); const key = String(req.body?.category_key || '').trim().toLowerCase();
      const expected = Number(req.body?.expected_version);
      if (!sedeId || !ID.test(itemId) || !ID.test(fileId) || !CATEGORY.test(key) || !Number.isSafeInteger(expected) || expected < 1) return fail(res, 400, 'Revisá pieza, archivo, versión y categoría');
      await client.query('begin');
      const item = (await client.query(`select id,version,payload from public.content_workspace_items where id=$1 for update`, [itemId])).rows[0];
      if (!item) { await client.query('rollback'); return fail(res, 404, 'Pieza inexistente'); }
      if (Number(item.version) !== expected) { await client.query('rollback'); return fail(res, 409, 'La versión de la pieza cambió'); }
      if (!['aprobado', 'publicado'].includes(String(item.payload?.status || ''))) { await client.query('rollback'); return fail(res, 409, 'La pieza no está aprobada'); }
      const file = (await client.query(`select id,item_id,mime_type from public.content_workspace_files where id=$1 and item_id=$2`, [fileId, itemId])).rows[0];
      if (!file || !MIME.test(String(file.mime_type || ''))) { await client.query('rollback'); return fail(res, 409, 'Archivo no válido para la biblioteca'); }
      const category = (await client.query(`select enabled from public.content_library_categories where sede_id=$1 and category_key=$2 for update`, [sedeId, key])).rows[0];
      if (!category?.enabled) { await client.query('rollback'); return fail(res, 409, 'La categoría no está habilitada para esta sede'); }
      const { rows } = await client.query(`insert into public.content_library_entries(sede_id,category_key,item_id,file_id,source_version,published_by)
        values($1,$2,$3,$4,$5,$6) on conflict(sede_id,item_id,file_id) do update set category_key=excluded.category_key,source_version=excluded.source_version,published_by=excluded.published_by,updated_at=now()
        returning id,category_key,source_version,item_id,file_id`, [sedeId, key, itemId, fileId, expected, auth.user.id]);
      await client.query('commit');
      return res.status(201).json({ entry: { ...rows[0], title: item.payload?.title || null, mime: file.mime_type } });
    } catch { try { if (client) await client.query('rollback'); } catch {} return fail(res, 503, 'No se pudo publicar la pieza'); }
    finally { if (client) client.release(); }
  });
  router.get('/:entryId/file', async (req, res) => {
    try {
      const auth = await admin(req, res); if (!auth) return;
      const sedeId = scopeFor(req, auth.role); if (!sedeId) return fail(res, 403, 'No tenés permiso para esta sede');
      if (!ID.test(req.params.entryId)) return fail(res, 404, 'Pieza inexistente');
      const entry = await visibleEntry(req.params.entryId, sedeId);
      if (!entry) return fail(res, 404, 'Pieza no disponible');
      let bucket;
      try { bucket = await deps.supabaseAdmin.storage.getBucket(BUCKET); } catch { return fail(res, 503, 'No se pudo verificar el almacenamiento'); }
      if (bucket?.error || !bucket?.data || bucket.data.public !== false) return fail(res, 503, 'El almacenamiento privado no está disponible');
      let signed;
      try { signed = await deps.supabaseAdmin.storage.from(BUCKET).createSignedUrl(entry.storage_path, 300); } catch { return fail(res, 503, 'No se pudo firmar el archivo'); }
      if (signed?.error || typeof signed?.data?.signedUrl !== 'string' || !signed.data.signedUrl) return fail(res, 503, 'No se pudo firmar el archivo');
      // Recheck scope, category, source approval/version and role after the awaited signing.
      const freshRole = await resolveAuthRoleForUser(auth.user, authDeps);
      const freshSede = freshRole.rol === 'super_admin' ? sedeId : freshRole.rol === 'admin_club' && Number(freshRole.sede_id) === Number(sedeId) ? freshRole.sede_id : null;
      if (!freshSede) return fail(res, 403, 'El acceso cambió durante la operación');
      const fresh = await visibleEntry(req.params.entryId, freshSede);
      if (!fresh) return fail(res, 404, 'La pieza ya no está disponible');
      return res.json({ url: signed.data.signedUrl, expiresIn: 300 });
    } catch { return fail(res, 503, 'No se pudo abrir el archivo'); }
  });
  return router;
}
