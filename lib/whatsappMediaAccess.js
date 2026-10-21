import { createHash, timingSafeEqual } from 'node:crypto';

const fail = (code, status = 503) => Object.assign(new Error('El archivo de WhatsApp no está disponible.'), { code, status });
const MAX_BYTES = 16 * 1024 * 1024;
const GRAPH_HOST = 'graph.facebook.com';
const MEDIA_HOST = 'lookaside.fbsbx.com';
const SAFE_EXTENSIONS = Object.freeze({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'video/mp4':'mp4', 'video/3gpp':'3gp', 'audio/ogg':'ogg', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/aac':'aac', 'audio/amr':'amr', 'application/pdf':'pdf' });

async function boundedBody(response, maxBytes) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw fail('WHATSAPP_MEDIA_TOO_LARGE', 413);
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw fail('WHATSAPP_MEDIA_UNAVAILABLE');
  let size = 0; const chunks = [];
  for await (const part of response.body) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > maxBytes) throw fail('WHATSAPP_MEDIA_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
function safeMetaUrl(raw) {
  let url; try { url = new URL(raw); } catch { throw fail('WHATSAPP_MEDIA_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST || url.port || url.username || url.password || url.hash || !url.pathname.startsWith('/whatsapp_business/'))
    throw fail('WHATSAPP_MEDIA_URL_INVALID');
  return url;
}
function expectedChecksum(value) {
  if (typeof value !== 'string') throw fail('WHATSAPP_MEDIA_CHECKSUM_MISSING');
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return Buffer.from(value, 'base64');
  throw fail('WHATSAPP_MEDIA_CHECKSUM_MISSING');
}

/** The caller must authenticate and authorize the conversation before this lookup.
 * No browser-supplied media ID or URL is accepted; the repository must bind the
 * event to both the authorized conversation and configured WhatsApp channel. */
export function createWhatsappMediaAccess({ repository, authorizeConversation, env = process.env, fetchImpl = globalThis.fetch, maxBytes = MAX_BYTES } = {}) {
  if (!repository?.findMediaReference || typeof authorizeConversation !== 'function' || typeof fetchImpl !== 'function') throw fail('WHATSAPP_MEDIA_CONFIG_INVALID');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw fail('WHATSAPP_MEDIA_CONFIG_INVALID');
  return async ({ user, conversationId, eventId } = {}) => {
    if (!user || !conversationId || !eventId) throw fail('WHATSAPP_MEDIA_FORBIDDEN', 403);
    await authorizeConversation({ user, conversationId });
    const ref = await repository.findMediaReference({ conversationId, eventId });
    const mediaId = String(ref?.mediaId || '');
    const phone = String(env.CRM_WHATSAPP_PHONE_NUMBER_ID || '');
    const token = String(env.CRM_WHATSAPP_ACCESS_TOKEN || '').trim();
    const version = String(env.WHATSAPP_META_GRAPH_VERSION || '');
    if (!/^[0-9]{1,100}$/.test(mediaId) || !/^[0-9]{5,30}$/.test(phone) || !/^v\d{1,3}\.0$/.test(version) || !token)
      throw fail('WHATSAPP_MEDIA_UNAVAILABLE');
    const metadataUrl = new URL(`https://${GRAPH_HOST}/${version}/${mediaId}`);
    metadataUrl.searchParams.set('phone_number_id', phone);
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const metaResponse = await fetchImpl(metadataUrl, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(10000) });
      if (!metaResponse.ok || metaResponse.redirected) throw fail('WHATSAPP_MEDIA_UNAVAILABLE');
      const metadata = JSON.parse((await boundedBody(metaResponse, 16384)).toString('utf8'));
      if (String(metadata.id || '') !== mediaId) throw fail('WHATSAPP_MEDIA_UNAVAILABLE');
      const expected = expectedChecksum(metadata.sha256);
      const url = safeMetaUrl(metadata.url);
      const size = Number(metadata.file_size);
      if (!Number.isInteger(size) || size < 1 || size > maxBytes) throw fail('WHATSAPP_MEDIA_TOO_LARGE', 413);
      const content = await fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(30000) });
      if (!content.ok || content.redirected) throw fail('WHATSAPP_MEDIA_UNAVAILABLE');
      const buffer = await boundedBody(content, maxBytes);
      if (buffer.length !== size || !timingSafeEqual(createHash('sha256').update(buffer).digest(), expected)) throw fail('WHATSAPP_MEDIA_INTEGRITY_FAILED');
      // Force download and forbid sniffing in the route; MIME and name from clients are never trusted.
      const extension = SAFE_EXTENSIONS[String(metadata.mime_type || '').split(';')[0].trim().toLowerCase()];
      return { buffer, contentType: 'application/octet-stream', filename: `adjunto-whatsapp${extension ? `.${extension}` : ''}` };
    } catch (e) { if (e?.code?.startsWith('WHATSAPP_MEDIA_')) throw e; throw fail('WHATSAPP_MEDIA_UNAVAILABLE'); }
  };
}

/** Resolves an event only within its authorized conversation and exact channel. */
export function createWhatsappMediaRepository({ supabaseAdmin, channelId, phoneNumberId } = {}) {
  if (!supabaseAdmin?.from || !/^[0-9a-f-]{36}$/i.test(String(channelId || '')) || !/^[0-9]{5,30}$/.test(String(phoneNumberId || ''))) throw fail('WHATSAPP_MEDIA_CONFIG_INVALID');
  return {
    async listMediaReferences({ conversationId }) {
      const events = await supabaseAdmin.from('crm_inbound_events').select('id,source_ref')
        .eq('conversation_id', conversationId).eq('source_channel', 'whatsapp')
        .eq('origin', `whatsapp:${phoneNumberId}`).order('received_at', { ascending: false }).limit(100);
      if (events.error) throw fail('WHATSAPP_MEDIA_UNAVAILABLE');
      if (!events.data?.length) return [];
      const ids = events.data.map(event => event.source_ref).filter(x => typeof x === 'string' && x.length > 0);
      if (!ids.length) return [];
      const inbound = await supabaseAdmin.from('whatsapp_inbound_messages').select('provider_message_id,meta_media_type')
        .eq('channel_id', channelId).in('provider_message_id', ids);
      if (inbound.error) throw fail('WHATSAPP_MEDIA_UNAVAILABLE');
      const types = new Map((inbound.data || []).filter(row => ['image','audio','video','document','sticker'].includes(row.meta_media_type))
        .map(row => [row.provider_message_id, row.meta_media_type]));
      return events.data.filter(event => types.has(event.source_ref)).map(event => ({ eventId: event.id, mediaType: types.get(event.source_ref) }));
    },
    async findMediaReference({ conversationId, eventId }) {
      const event = await supabaseAdmin.from('crm_inbound_events').select('source_ref')
        .eq('id', eventId).eq('conversation_id', conversationId).eq('source_channel', 'whatsapp')
        .eq('origin', `whatsapp:${phoneNumberId}`).maybeSingle();
      if (event.error || !event.data?.source_ref) throw fail('WHATSAPP_MEDIA_UNAVAILABLE', 404);
      const inbound = await supabaseAdmin.from('whatsapp_inbound_messages').select('meta_media_id,meta_media_type')
        .eq('channel_id', channelId).eq('provider_message_id', event.data.source_ref).maybeSingle();
      if (inbound.error || !inbound.data?.meta_media_id || !['image','audio','video','document','sticker'].includes(inbound.data.meta_media_type))
        throw fail('WHATSAPP_MEDIA_UNAVAILABLE', 404);
      return { mediaId: inbound.data.meta_media_id, mediaType: inbound.data.meta_media_type };
    },
  };
}

/** Register a private endpoint; the CRM service owns conversation authorization. */
export function registerWhatsappMediaAccessRoute(app, { crmAdminService, supabaseAdmin, authUserFromBearer, fetchUserRoleRow, fetchUserRoleRowForAuthUser, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!crmAdminService?.getInbox || !supabaseAdmin?.from || typeof authUserFromBearer !== 'function') return;
  app.get('/api/admin/crm/conversations/:conversationId/whatsapp-media', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id || !user?.email) throw fail('WHATSAPP_MEDIA_UNAUTHENTICATED', 401);
      const row = typeof fetchUserRoleRowForAuthUser === 'function' ? await fetchUserRoleRowForAuthUser(user) : await fetchUserRoleRow(user.email);
      await crmAdminService.getInbox({ email: user.email, userId: user.id, role: row?.role ?? null, id: req.params.conversationId });
      const repository = createWhatsappMediaRepository({ supabaseAdmin, channelId: env.CRM_WHATSAPP_CHANNEL_ID, phoneNumberId: env.CRM_WHATSAPP_PHONE_NUMBER_ID });
      return res.json({ attachments: await repository.listMediaReferences({ conversationId: req.params.conversationId }) });
    } catch (error) {
      const status = [401, 403, 404].includes(Number(error?.status)) ? Number(error.status) : 503;
      return res.status(status).json({ code: status === 401 ? 'WHATSAPP_MEDIA_UNAUTHENTICATED' : status === 403 ? 'WHATSAPP_MEDIA_FORBIDDEN' : status === 404 ? 'WHATSAPP_MEDIA_NOT_FOUND' : 'WHATSAPP_MEDIA_UNAVAILABLE' });
    }
  });
  app.get('/api/admin/crm/conversations/:conversationId/events/:eventId/whatsapp-media', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id || !user?.email) throw fail('WHATSAPP_MEDIA_UNAUTHENTICATED', 401);
      const row = typeof fetchUserRoleRowForAuthUser === 'function'
        ? await fetchUserRoleRowForAuthUser(user)
        : await fetchUserRoleRow(user.email);
      const context = { email: user.email, userId: user.id, role: row?.role ?? null };
      // Authorization occurs before resolving any database reference or contacting Meta.
      await crmAdminService.getInbox({ ...context, id: req.params.conversationId });
      const repository = createWhatsappMediaRepository({ supabaseAdmin, channelId: env.CRM_WHATSAPP_CHANNEL_ID, phoneNumberId: env.CRM_WHATSAPP_PHONE_NUMBER_ID });
      const retrieve = createWhatsappMediaAccess({ repository, env, fetchImpl,
        authorizeConversation: async ({ conversationId }) => {
          if (conversationId !== req.params.conversationId) throw fail('WHATSAPP_MEDIA_FORBIDDEN', 403);
        } });
      const result = await retrieve({ user, conversationId: req.params.conversationId, eventId: req.params.eventId });
      res.set('Content-Type', result.contentType);
      res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
      return res.status(200).send(result.buffer);
    } catch (error) {
      const status = [401, 403, 404, 413].includes(Number(error?.status)) ? Number(error.status) : 503;
      return res.status(status).json({ code: status === 401 ? 'WHATSAPP_MEDIA_UNAUTHENTICATED' : status === 403 ? 'WHATSAPP_MEDIA_FORBIDDEN' : status === 404 ? 'WHATSAPP_MEDIA_NOT_FOUND' : status === 413 ? 'WHATSAPP_MEDIA_TOO_LARGE' : 'WHATSAPP_MEDIA_UNAVAILABLE' });
    }
  });
}
