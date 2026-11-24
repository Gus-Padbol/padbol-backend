import express from 'express';
import crypto from 'node:crypto';
import { requireAdminUser, requireSuperAdminUser, resolveAuthRoleForUser } from '../lib/authAccess.js';

const BUCKET = 'content-workspace-private';
const CATEGORY = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MIME = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime))$/;
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEDE = (v) => {
  const s = String(v ?? '').trim();
  return /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
};
const fail = (res, status, message) => res.status(status).json({ error: message });

function imageSignatureMatches(buffer, mime) {
  if (!buffer || buffer.length < 4 || !IMAGE_MIME.test(mime)) return false;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === 'image/gif') return /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'));
  if (mime === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}
const imageEnabled = () => process.env.CONTENT_PRIVATE_DESIGNS_ENABLED === 'true';
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
  const dto = (row) => ({
    id: row.id, title: row.title, category: row.category_key, format: row.format || null,
    assetKind: row.asset_kind || null, mime: row.mime_type, sourceVersion: Number(row.source_version),
  });
  function scope(req, role) {
    if (role.rol === 'admin_club') {
      if (req.query.sede_id != null && Number(req.query.sede_id) !== Number(role.sede_id)) return { status: 403 };
      return { sedeId: Number(role.sede_id) };
    }
    if (role.rol === 'super_admin') {
      if (req.query.sede_id == null) return { sedeId: null };
      const sedeId = SEDE(req.query.sede_id);
      return sedeId ? { sedeId } : { status: 400 };
    }
    return { status: 403 };
  }
  async function visibleEntry(entryId, sedeId = null) {
    const params = [entryId];
    let grant = '';
    if (sedeId != null) {
      params.push(sedeId);
      grant = ' join public.content_library_categories c on c.sede_id=$2 and c.category_key=e.category_key and c.enabled';
    }
    const { rows } = await query(`select e.id,e.category_key,e.item_id,e.file_id,e.source_version,e.enabled,
      i.payload->>'title' title,i.payload->>'format' format,i.payload->>'assetKind' asset_kind,
      f.mime_type,f.size,f.storage_path
      from public.content_library_entries e${grant}
      join public.content_workspace_items i on i.id=e.item_id and i.version=e.source_version
      join public.content_workspace_files f on f.id=e.file_id and f.item_id=i.id
      where e.id=$1 and e.enabled and i.payload->>'status' in ('aprobado','publicado')`, params);
    return rows[0] || null;
  }
  router.get('/', async (req, res) => {
    try {
      const auth = await admin(req, res); if (!auth) return;
      const s = scope(req, auth.role); if (s.status) return fail(res, s.status, s.status === 400 ? 'Sede inválida' : 'No tenés permiso para esta sede');
      const params = []; let grant = '';
      if (s.sedeId != null) { params.push(s.sedeId); grant = ' join public.content_library_categories c on c.sede_id=$1 and c.category_key=e.category_key and c.enabled'; }
      const { rows } = await query(`select e.id,e.category_key,e.source_version,
        i.payload->>'title' title,i.payload->>'format' format,i.payload->>'assetKind' asset_kind,f.mime_type
        from public.content_library_entries e${grant}
        join public.content_workspace_items i on i.id=e.item_id and i.version=e.source_version
        join public.content_workspace_files f on f.id=e.file_id and f.item_id=i.id
        where e.enabled and i.payload->>'status' in ('aprobado','publicado')
        order by e.updated_at desc,e.id limit 50`, params);
      return res.json({ items: rows.map(dto) });
    } catch { return fail(res, 503, 'No se pudo cargar la biblioteca'); }
  });
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
      const itemId = String(req.body?.item_id || ''); const fileId = String(req.body?.file_id || '');
      const key = String(req.body?.category_key || '').trim().toLowerCase();
      const expected = Number(req.body?.expected_version);
      const enabled = req.body?.enabled !== false;
      if (!ID.test(itemId) || !ID.test(fileId) || !CATEGORY.test(key) || !Number.isSafeInteger(expected) || expected < 1) return fail(res, 400, 'Revisá pieza, archivo, versión, categoría y estado');
      await client.query('begin');
      const item = (await client.query('select id,version,payload from public.content_workspace_items where id=$1 for update', [itemId])).rows[0];
      if (!item) { await client.query('rollback'); return fail(res, 404, 'Pieza inexistente'); }
      if (Number(item.version) !== expected) { await client.query('rollback'); return fail(res, 409, 'La versión de la pieza cambió'); }
      if (!['aprobado', 'publicado'].includes(String(item.payload?.status || ''))) { await client.query('rollback'); return fail(res, 409, 'La pieza no está aprobada'); }
      const file = (await client.query('select id,item_id,mime_type from public.content_workspace_files where id=$1 and item_id=$2', [fileId, itemId])).rows[0];
      if (!file || !MIME.test(String(file.mime_type || ''))) { await client.query('rollback'); return fail(res, 409, 'Archivo no válido para la biblioteca'); }
      const { rows } = await client.query(`insert into public.content_library_entries(category_key,item_id,file_id,source_version,enabled,published_by)
        values($1,$2,$3,$4,$5,$6) on conflict(item_id,file_id) do update set category_key=excluded.category_key,source_version=excluded.source_version,enabled=excluded.enabled,published_by=excluded.published_by,updated_at=now()
        returning id,category_key,source_version,item_id,file_id,enabled`, [key, itemId, fileId, expected, enabled, auth.user.id]);
      await client.query('commit');
      return res.status(201).json({ entry: { ...rows[0], title: item.payload?.title || null, mime: file.mime_type } });
    } catch { try { if (client) await client.query('rollback'); } catch {} return fail(res, 503, 'No se pudo publicar la pieza'); }
    finally { if (client) client.release(); }
  });
  router.get('/:entryId/file', async (req, res) => {
    try {
      const auth = await admin(req, res); if (!auth) return;
      const s = scope(req, auth.role); if (s.status) return fail(res, s.status, 'No tenés permiso para esta sede');
      if (!ID.test(req.params.entryId)) return fail(res, 404, 'Pieza inexistente');
      const entry = await visibleEntry(req.params.entryId, s.sedeId);
      if (!entry) return fail(res, 404, 'Pieza no disponible');
      let bucket;
      try { bucket = await deps.supabaseAdmin.storage.getBucket(BUCKET); } catch { return fail(res, 503, 'No se pudo verificar el almacenamiento'); }
      if (bucket?.error || !bucket?.data || bucket.data.public !== false) return fail(res, 503, 'El almacenamiento privado no está disponible');
      let signed;
      try { signed = await deps.supabaseAdmin.storage.from(BUCKET).createSignedUrl(entry.storage_path, 300); } catch { return fail(res, 503, 'No se pudo firmar el archivo'); }
      if (signed?.error || typeof signed?.data?.signedUrl !== 'string' || !signed.data.signedUrl) return fail(res, 503, 'No se pudo firmar el archivo');
      const freshRole = await resolveAuthRoleForUser(auth.user, authDeps);
      if (freshRole.rol === 'admin_club') {
        if (s.sedeId == null || Number(freshRole.sede_id) !== Number(s.sedeId)) return fail(res, 403, 'El acceso cambió durante la operación');
      } else if (freshRole.rol === 'super_admin') {
        if (s.sedeId != null && !SEDE(s.sedeId)) return fail(res, 403, 'El acceso cambió durante la operación');
      } else return fail(res, 403, 'El acceso cambió durante la operación');
      const fresh = await visibleEntry(req.params.entryId, s.sedeId);
      if (!fresh) return fail(res, 404, 'La pieza ya no está disponible');
      return res.json({ url: signed.data.signedUrl, expiresIn: 300 });
    } catch { return fail(res, 503, 'No se pudo abrir el archivo'); }
  });
  router.get('/:entryId/image', async (req, res) => {
    if (!imageEnabled()) return fail(res, 503, 'El editor de imágenes privadas está deshabilitado');
    try {
      const auth = await admin(req, res); if (!auth) return;
      const s = scope(req, auth.role); if (s.status) return fail(res, s.status, s.status === 400 ? 'Sede inválida' : 'No tenés permiso para esta sede');
      if (!ID.test(req.params.entryId)) return fail(res, 404, 'Pieza inexistente');
      const sourceVersion = Number(req.query.source_version);
      if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) return fail(res, 400, 'source_version es obligatorio');
      const entry = await visibleEntry(req.params.entryId, s.sedeId);
      if (!entry) return fail(res, 404, 'Pieza no disponible');
      if (Number(entry.source_version) !== sourceVersion) return fail(res, 409, 'La versión de la pieza cambió');
      if (!IMAGE_MIME.test(String(entry.mime_type || ''))) return fail(res, 415, 'El archivo no es una imagen admitida');
      if (Number(entry.size) > MAX_IMAGE_BYTES) return fail(res, 413, 'La imagen supera 8 MiB');
      let bucket;
      try { bucket = await deps.supabaseAdmin.storage.getBucket(BUCKET); } catch { return fail(res, 503, 'No se pudo verificar el almacenamiento'); }
      if (bucket?.error || !bucket?.data || bucket.data.public !== false) return fail(res, 503, 'El almacenamiento privado no está disponible');
      let downloaded;
      try { downloaded = await deps.supabaseAdmin.storage.from(BUCKET).download(entry.storage_path); } catch { return fail(res, 503, 'No se pudo leer la imagen'); }
      if (downloaded?.error || !downloaded?.data) return fail(res, 503, 'No se pudo leer la imagen');
      const blob = downloaded.data;
      if (Number(blob.size) > MAX_IMAGE_BYTES) return fail(res, 413, 'La imagen supera 8 MiB');
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) return fail(res, 413, 'La imagen supera 8 MiB');
      if (String(blob.type || '').split(';')[0].trim().toLowerCase() !== String(entry.mime_type || '').toLowerCase() || !imageSignatureMatches(bytes, String(entry.mime_type || '').toLowerCase())) return fail(res, 415, 'La imagen no coincide con un formato seguro');
      const freshRole = await resolveAuthRoleForUser(auth.user, authDeps);
      if (freshRole.rol === 'admin_club') {
        if (s.sedeId == null || Number(freshRole.sede_id) !== Number(s.sedeId)) return fail(res, 403, 'El acceso cambió durante la operación');
      } else if (freshRole.rol !== 'super_admin') return fail(res, 403, 'El acceso cambió durante la operación');
      const fresh = await visibleEntry(req.params.entryId, s.sedeId);
      if (!fresh) return fail(res, 404, 'La pieza ya no está disponible');
      if (Number(fresh.source_version) !== sourceVersion) return fail(res, 409, 'La versión de la pieza cambió');
      res.setHeader('Content-Type', String(entry.mime_type).toLowerCase());
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Vary', 'Authorization');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Content-SHA256', crypto.createHash('sha256').update(bytes).digest('hex'));
      res.setHeader('Content-Length', String(bytes.length));
      return res.status(200).send(bytes);
    } catch { return fail(res, 503, 'No se pudo leer la imagen'); }
  });
  return router;
}
