import { createNotificacionIfAbsent } from '../../utils/notificaciones.js';
import {
  TEXTO_MAX,
  COMENTARIO_MAX,
  MOTIVO_MAX,
  assertCanDeleteComentario,
  assertCanDeletePublicacion,
  assertCanEditPublicacion,
  assertCanFollow,
  assertCanInteractDespiteBlocks,
  buildComunidadNotificacionDedupeKey,
  filterFeedVisibility,
  httpError,
  isMissingComunidadTableError,
  isModeratorRole,
  mapAutorPublico,
  mapComentarioDto,
  mapPublicacionDto,
  mapUsuarioResumenDto,
  normalizeVisibilidad,
  parseFeedLimit,
  parsePositiveInt,
  sanitizePlainText,
  toggleReactionState,
} from '../../lib/comunidadDomain.js';

function schemaUnavailable(err) {
  if (isMissingComunidadTableError(err)) {
    return httpError(503, 'Comunidad aún no disponible — migración SQL pendiente');
  }
  return err;
}

async function loadPerfilesByUserIds(supabaseAdmin, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id,nombre,apellido,apodo,foto_url')
    .in('user_id', ids);
  if (error) throw error;
  const map = new Map();
  for (const row of data || []) map.set(String(row.user_id), row);
  return map;
}

async function loadBlockPairs(supabaseAdmin, userId) {
  if (!userId) return [];
  const { data, error } = await supabaseAdmin
    .from('comunidad_bloqueos')
    .select('blocker_user_id,blocked_user_id')
    .or(`blocker_user_id.eq.${userId},blocked_user_id.eq.${userId}`);
  if (error) throw schemaUnavailable(error);
  return data || [];
}

function blockedUserIdSet(pairs, viewerId) {
  const set = new Set();
  for (const p of pairs || []) {
    if (String(p.blocker_user_id) === String(viewerId)) set.add(String(p.blocked_user_id));
    if (String(p.blocked_user_id) === String(viewerId)) set.add(String(p.blocker_user_id));
  }
  return set;
}

async function loadFollowingIds(supabaseAdmin, followerId) {
  if (!followerId) return new Set();
  const { data, error } = await supabaseAdmin
    .from('comunidad_seguimientos')
    .select('following_user_id')
    .eq('follower_user_id', followerId);
  if (error) throw schemaUnavailable(error);
  return new Set((data || []).map((r) => String(r.following_user_id)));
}

async function countsForPublicaciones(supabaseAdmin, pubIds) {
  const ids = [...new Set(pubIds)];
  const reacciones = new Map();
  const comentarios = new Map();
  if (!ids.length) return { reacciones, comentarios };

  const { data: reac, error: rErr } = await supabaseAdmin
    .from('comunidad_reacciones')
    .select('publicacion_id')
    .in('publicacion_id', ids);
  if (rErr) throw schemaUnavailable(rErr);
  for (const row of reac || []) {
    const k = String(row.publicacion_id);
    reacciones.set(k, (reacciones.get(k) || 0) + 1);
  }

  const { data: coms, error: cErr } = await supabaseAdmin
    .from('comunidad_comentarios')
    .select('publicacion_id')
    .in('publicacion_id', ids)
    .eq('estado', 'activo');
  if (cErr) throw schemaUnavailable(cErr);
  for (const row of coms || []) {
    const k = String(row.publicacion_id);
    comentarios.set(k, (comentarios.get(k) || 0) + 1);
  }
  return { reacciones, comentarios };
}

async function viewerReactions(supabaseAdmin, pubIds, viewerId) {
  const set = new Set();
  if (!viewerId || !pubIds.length) return set;
  const { data, error } = await supabaseAdmin
    .from('comunidad_reacciones')
    .select('publicacion_id')
    .eq('user_id', viewerId)
    .in('publicacion_id', pubIds);
  if (error) throw schemaUnavailable(error);
  for (const row of data || []) set.add(String(row.publicacion_id));
  return set;
}

async function hydratePublicaciones(supabaseAdmin, rows, viewerId) {
  const list = rows || [];
  const ids = list.map((r) => r.id);
  const { data: mediaRows, error: mediaError } = ids.length
    ? await supabaseAdmin
      .from('comunidad_medios')
      .select('publicacion_id,tipo,storage_path,orden,estado')
      .in('publicacion_id', ids)
      .eq('estado', 'listo')
      .order('orden', { ascending: true })
    : { data: [], error: null };
  if (mediaError) throw schemaUnavailable(mediaError);
  const photoByPost = new Map();
  await Promise.all((mediaRows || [])
    .filter((media) => media.tipo === 'foto' && !photoByPost.has(String(media.publicacion_id)))
    .map(async (media) => {
      const { data, error } = await supabaseAdmin.storage
        .from('comunidad-media')
        .createSignedUrl(media.storage_path, 60 * 60 * 24 * 7);
      if (!error && data?.signedUrl) photoByPost.set(String(media.publicacion_id), data.signedUrl);
    }));
  const hydratedRows = list.map((row) => ({
    ...row,
    imagen_url: photoByPost.get(String(row.id)) || row.imagen_url,
  }));
  const perfiles = await loadPerfilesByUserIds(supabaseAdmin, list.map((r) => r.autor_user_id));
  const { reacciones, comentarios } = await countsForPublicaciones(supabaseAdmin, ids);
  const reacted = await viewerReactions(supabaseAdmin, ids, viewerId);
  return hydratedRows.map((row) => mapPublicacionDto(row, {
    autor: mapAutorPublico(perfiles.get(String(row.autor_user_id)) || { user_id: row.autor_user_id }),
    reacciones_count: reacciones.get(String(row.id)) || 0,
    comentarios_count: comentarios.get(String(row.id)) || 0,
    reacted: reacted.has(String(row.id)),
  }));
}

async function notifyComunidad(supabaseAdmin, {
  event,
  userId,
  titulo,
  mensaje,
  link,
  dedupeParts,
}) {
  if (!userId) return;
  const dedupe_key = buildComunidadNotificacionDedupeKey(event, dedupeParts);
  try {
    await createNotificacionIfAbsent(supabaseAdmin, {
      user_id: userId,
      tipo: event,
      titulo,
      mensaje,
      link: link || 'padbolmatch://comunidad',
      data: {
        dedupe_key,
        tipo: event,
        navegacion: { screen: 'Comunidad', params: dedupeParts },
      },
    });
  } catch (err) {
    console.warn(`⚠️ notif comunidad ${event}:`, err.message);
  }
}

export function createComunidadService({ supabaseAdmin }) {
  async function requireTables() {
    const { error } = await supabaseAdmin.from('comunidad_publicaciones').select('id').limit(1);
    if (error) throw schemaUnavailable(error);
  }

  return {
    async createPublicacion(user, body) {
      await requireTables();
      const texto = sanitizePlainText(body?.texto, { max: TEXTO_MAX });
      if (!texto) throw httpError(400, 'texto es requerido');
      const imagen_url = body?.imagen_url ? String(body.imagen_url).trim().slice(0, 2000) : null;
      if (imagen_url && !/^https?:\/\//i.test(imagen_url)) {
        throw httpError(400, 'imagen_url inválida');
      }
      const sede_id = body?.sede_id != null ? parsePositiveInt(body.sede_id) : null;
      const evento_ref = body?.evento_ref ? String(body.evento_ref).trim().slice(0, 200) : null;
      const visibilidad = normalizeVisibilidad(body?.visibilidad, 'publica');
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .insert([{
          autor_user_id: user.id,
          texto,
          imagen_url,
          sede_id,
          evento_ref,
          visibilidad,
          estado: 'activa',
          created_at: now,
          updated_at: now,
        }])
        .select('*')
        .single();
      if (error) throw schemaUnavailable(error);
      const [dto] = await hydratePublicaciones(supabaseAdmin, [data], user.id);
      return dto;
    },

    async updatePublicacion(user, publicacionId, body) {
      const id = parsePositiveInt(publicacionId);
      if (!id) throw httpError(400, 'ID inválido');
      const { data: pub, error } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw schemaUnavailable(error);
      const denied = assertCanEditPublicacion(pub, user);
      if (denied) throw denied;

      const patch = { updated_at: new Date().toISOString() };
      if (body?.texto != null) {
        const texto = sanitizePlainText(body.texto, { max: TEXTO_MAX });
        if (!texto) throw httpError(400, 'texto es requerido');
        patch.texto = texto;
      }
      if (body?.imagen_url !== undefined) {
        if (body.imagen_url == null || body.imagen_url === '') patch.imagen_url = null;
        else {
          const imagen_url = String(body.imagen_url).trim().slice(0, 2000);
          if (!/^https?:\/\//i.test(imagen_url)) throw httpError(400, 'imagen_url inválida');
          patch.imagen_url = imagen_url;
        }
      }
      if (body?.visibilidad != null) patch.visibilidad = normalizeVisibilidad(body.visibilidad);
      if (body?.sede_id !== undefined) {
        patch.sede_id = body.sede_id == null ? null : parsePositiveInt(body.sede_id);
      }
      if (body?.evento_ref !== undefined) {
        patch.evento_ref = body.evento_ref ? String(body.evento_ref).trim().slice(0, 200) : null;
      }

      const { data, error: uErr } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (uErr) throw schemaUnavailable(uErr);
      const [dto] = await hydratePublicaciones(supabaseAdmin, [data], user.id);
      return dto;
    },

    async deletePublicacion(user, publicacionId, { isModerator = false } = {}) {
      const id = parsePositiveInt(publicacionId);
      if (!id) throw httpError(400, 'ID inválido');
      const { data: pub, error } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw schemaUnavailable(error);
      const denied = assertCanDeletePublicacion(pub, user, { isModerator });
      if (denied) throw denied;

      const { data, error: uErr } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .update({ estado: 'eliminada', updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id,estado')
        .single();
      if (uErr) throw schemaUnavailable(uErr);
      return { success: true, id: data.id, estado: data.estado };
    },

    async getPublicacion(user, publicacionId) {
      const id = parsePositiveInt(publicacionId);
      if (!id) throw httpError(400, 'ID inválido');
      const { data: pub, error } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw schemaUnavailable(error);
      if (!pub || pub.estado === 'eliminada') throw httpError(404, 'Publicación no encontrada');
      if (pub.estado === 'ocultada' && pub.autor_user_id !== user?.id) {
        throw httpError(404, 'Publicación no encontrada');
      }

      const pairs = await loadBlockPairs(supabaseAdmin, user?.id);
      const blocked = blockedUserIdSet(pairs, user?.id);
      if (user?.id && blocked.has(String(pub.autor_user_id))) {
        throw httpError(403, 'No podés ver este contenido');
      }
      if (pub.visibilidad === 'seguidores' && user?.id !== pub.autor_user_id) {
        const following = await loadFollowingIds(supabaseAdmin, user?.id);
        if (!following.has(String(pub.autor_user_id))) {
          throw httpError(403, 'Publicación solo visible para seguidores');
        }
      }
      const [dto] = await hydratePublicaciones(supabaseAdmin, [pub], user?.id);
      return dto;
    },

    async getFeed(user, { cursor, limit } = {}) {
      await requireTables();
      const lim = parseFeedLimit(limit);
      const viewerId = user?.id || null;
      const pairs = await loadBlockPairs(supabaseAdmin, viewerId);
      const blocked = blockedUserIdSet(pairs, viewerId);
      const following = await loadFollowingIds(supabaseAdmin, viewerId);

      let q = supabaseAdmin
        .from('comunidad_publicaciones')
        .select('*')
        .eq('estado', 'activa')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(lim * 3);

      if (cursor) {
        // cursor = created_at|id
        const [cAt, cId] = String(cursor).split('|');
        if (cAt) q = q.lt('created_at', cAt);
      }

      const { data, error } = await q;
      if (error) throw schemaUnavailable(error);

      const filtered = filterFeedVisibility(data || [], {
        viewerId,
        followingIds: following,
        blockedUserIds: blocked,
      }).slice(0, lim);

      const items = await hydratePublicaciones(supabaseAdmin, filtered, viewerId);
      const last = filtered[filtered.length - 1];
      const next_cursor = last ? `${last.created_at}|${last.id}` : null;
      return { items, next_cursor, limit: lim };
    },

    async listComentarios(user, publicacionId, { limit = 30 } = {}) {
      await this.getPublicacion(user, publicacionId);
      const id = parsePositiveInt(publicacionId);
      const lim = Math.min(parseFeedLimit(limit), 50);
      const { data, error } = await supabaseAdmin
        .from('comunidad_comentarios')
        .select('*')
        .eq('publicacion_id', id)
        .eq('estado', 'activo')
        .order('created_at', { ascending: true })
        .limit(lim);
      if (error) throw schemaUnavailable(error);
      const pairs = await loadBlockPairs(supabaseAdmin, user?.id);
      const blocked = blockedUserIdSet(pairs, user?.id);
      const visible = (data || []).filter((c) => !blocked.has(String(c.autor_user_id)));
      const perfiles = await loadPerfilesByUserIds(supabaseAdmin, visible.map((c) => c.autor_user_id));
      return {
        comentarios: visible.map((c) => mapComentarioDto(
          c,
          mapAutorPublico(perfiles.get(String(c.autor_user_id)) || { user_id: c.autor_user_id }),
        )),
      };
    },

    async createComentario(user, publicacionId, body) {
      await this.getPublicacion(user, publicacionId);
      const pairs = await loadBlockPairs(supabaseAdmin, user.id);
      const { data: rawPub } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .select('id,autor_user_id')
        .eq('id', parsePositiveInt(publicacionId))
        .maybeSingle();
      const blockErr = assertCanInteractDespiteBlocks({
        actorId: user.id,
        targetAuthorId: rawPub?.autor_user_id,
        blockedPairIds: pairs,
      });
      if (blockErr) throw blockErr;

      const texto = sanitizePlainText(body?.texto, { max: COMENTARIO_MAX });
      if (!texto) throw httpError(400, 'texto es requerido');
      const idempotency_key = body?.idempotency_key
        ? String(body.idempotency_key).trim().slice(0, 120)
        : null;

      if (idempotency_key) {
        const { data: existing } = await supabaseAdmin
          .from('comunidad_comentarios')
          .select('*')
          .eq('publicacion_id', rawPub.id)
          .eq('autor_user_id', user.id)
          .eq('idempotency_key', idempotency_key)
          .eq('estado', 'activo')
          .maybeSingle();
        if (existing) {
          const perfiles = await loadPerfilesByUserIds(supabaseAdmin, [user.id]);
          return {
            comentario: mapComentarioDto(
              existing,
              mapAutorPublico(perfiles.get(String(user.id)) || { user_id: user.id }),
            ),
            idempotent: true,
          };
        }
      }

      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('comunidad_comentarios')
        .insert([{
          publicacion_id: rawPub.id,
          autor_user_id: user.id,
          texto,
          estado: 'activo',
          idempotency_key,
          created_at: now,
          updated_at: now,
        }])
        .select('*')
        .single();
      if (error) {
        if (String(error.message || '').includes('idx_comunidad_comentarios_idempotency')) {
          const { data: again } = await supabaseAdmin
            .from('comunidad_comentarios')
            .select('*')
            .eq('publicacion_id', rawPub.id)
            .eq('autor_user_id', user.id)
            .eq('idempotency_key', idempotency_key)
            .maybeSingle();
          if (again) {
            const perfiles = await loadPerfilesByUserIds(supabaseAdmin, [user.id]);
            return {
              comentario: mapComentarioDto(
                again,
                mapAutorPublico(perfiles.get(String(user.id)) || { user_id: user.id }),
              ),
              idempotent: true,
            };
          }
        }
        throw schemaUnavailable(error);
      }

      if (rawPub.autor_user_id && rawPub.autor_user_id !== user.id) {
        await notifyComunidad(supabaseAdmin, {
          event: 'comunidad_comentario',
          userId: rawPub.autor_user_id,
          titulo: 'Nuevo comentario',
          mensaje: 'Comentaron tu publicación',
          link: `padbolmatch://comunidad/publicacion/${rawPub.id}`,
          dedupeParts: { publicacionId: rawPub.id, comentarioId: data.id, userId: user.id },
        });
      }

      const perfiles = await loadPerfilesByUserIds(supabaseAdmin, [user.id]);
      return {
        comentario: mapComentarioDto(
          data,
          mapAutorPublico(perfiles.get(String(user.id)) || { user_id: user.id }),
        ),
        idempotent: false,
      };
    },

    async deleteComentario(user, comentarioId, { isModerator = false } = {}) {
      const id = parsePositiveInt(comentarioId);
      if (!id) throw httpError(400, 'ID inválido');
      const { data: com, error } = await supabaseAdmin
        .from('comunidad_comentarios')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw schemaUnavailable(error);
      const denied = assertCanDeleteComentario(com, user, { isModerator });
      if (denied) throw denied;
      const { error: uErr } = await supabaseAdmin
        .from('comunidad_comentarios')
        .update({ estado: 'eliminado', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (uErr) throw schemaUnavailable(uErr);
      return { success: true, id };
    },

    async toggleReaccion(user, publicacionId) {
      const pub = await this.getPublicacion(user, publicacionId);
      const id = parsePositiveInt(publicacionId);
      const pairs = await loadBlockPairs(supabaseAdmin, user.id);
      const { data: rawPub } = await supabaseAdmin
        .from('comunidad_publicaciones')
        .select('id,autor_user_id')
        .eq('id', id)
        .maybeSingle();
      const blockErr = assertCanInteractDespiteBlocks({
        actorId: user.id,
        targetAuthorId: rawPub?.autor_user_id,
        blockedPairIds: pairs,
      });
      if (blockErr) throw blockErr;

      const { data: existing, error } = await supabaseAdmin
        .from('comunidad_reacciones')
        .select('*')
        .eq('publicacion_id', id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw schemaUnavailable(error);

      const next = toggleReactionState(existing);
      if (existing) {
        const { error: dErr } = await supabaseAdmin
          .from('comunidad_reacciones')
          .delete()
          .eq('id', existing.id);
        if (dErr) throw schemaUnavailable(dErr);
      } else {
        const { error: iErr } = await supabaseAdmin
          .from('comunidad_reacciones')
          .insert([{ publicacion_id: id, user_id: user.id, tipo: 'like' }]);
        if (iErr) throw schemaUnavailable(iErr);
        if (rawPub?.autor_user_id && rawPub.autor_user_id !== user.id) {
          await notifyComunidad(supabaseAdmin, {
            event: 'comunidad_reaccion',
            userId: rawPub.autor_user_id,
            titulo: 'Nueva reacción',
            mensaje: 'Alguien reaccionó a tu publicación',
            link: `padbolmatch://comunidad/publicacion/${id}`,
            dedupeParts: { publicacionId: id, userId: user.id },
          });
        }
      }

      const hydrated = await this.getPublicacion(user, id);
      return {
        reacted: next.reacted,
        action: next.action,
        publicacion: hydrated || pub,
      };
    },

    async seguir(user, targetUserId) {
      const targetId = String(targetUserId || '').trim();
      const selfErr = assertCanFollow({ actorId: user.id, targetId });
      if (selfErr) throw selfErr;
      const pairs = await loadBlockPairs(supabaseAdmin, user.id);
      const blockErr = assertCanInteractDespiteBlocks({
        actorId: user.id,
        targetAuthorId: targetId,
        blockedPairIds: pairs,
      });
      if (blockErr) throw blockErr;

      const { data: existing } = await supabaseAdmin
        .from('comunidad_seguimientos')
        .select('id')
        .eq('follower_user_id', user.id)
        .eq('following_user_id', targetId)
        .maybeSingle();
      if (existing) return { success: true, following: true, idempotent: true };

      const { error } = await supabaseAdmin
        .from('comunidad_seguimientos')
        .insert([{ follower_user_id: user.id, following_user_id: targetId }]);
      if (error) {
        if (/duplicate|unique/i.test(error.message || '')) {
          return { success: true, following: true, idempotent: true };
        }
        throw schemaUnavailable(error);
      }

      await notifyComunidad(supabaseAdmin, {
        event: 'comunidad_nuevo_seguidor',
        userId: targetId,
        titulo: 'Nuevo seguidor',
        mensaje: 'Alguien comenzó a seguirte',
        link: `padbolmatch://comunidad/perfil/${user.id}`,
        dedupeParts: { followerId: user.id, followingId: targetId },
      });

      return { success: true, following: true, idempotent: false };
    },

    async dejarDeSeguir(user, targetUserId) {
      const targetId = String(targetUserId || '').trim();
      const selfErr = assertCanFollow({ actorId: user.id, targetId });
      if (selfErr) throw selfErr;
      await supabaseAdmin
        .from('comunidad_seguimientos')
        .delete()
        .eq('follower_user_id', user.id)
        .eq('following_user_id', targetId);
      return { success: true, following: false };
    },

    async bloquear(user, targetUserId) {
      const targetId = String(targetUserId || '').trim();
      if (!targetId) throw httpError(400, 'Usuario inválido');
      if (targetId === user.id) throw httpError(400, 'No podés bloquearte a vos mismo');

      const { data: existing } = await supabaseAdmin
        .from('comunidad_bloqueos')
        .select('id')
        .eq('blocker_user_id', user.id)
        .eq('blocked_user_id', targetId)
        .maybeSingle();
      if (!existing) {
        const { error } = await supabaseAdmin
          .from('comunidad_bloqueos')
          .insert([{ blocker_user_id: user.id, blocked_user_id: targetId }]);
        if (error && !/duplicate|unique/i.test(error.message || '')) {
          throw schemaUnavailable(error);
        }
      }
      // Unfollow both directions (interactions blocked); do not delete posts/history
      await supabaseAdmin
        .from('comunidad_seguimientos')
        .delete()
        .eq('follower_user_id', user.id)
        .eq('following_user_id', targetId);
      await supabaseAdmin
        .from('comunidad_seguimientos')
        .delete()
        .eq('follower_user_id', targetId)
        .eq('following_user_id', user.id);
      return { success: true, blocked: true };
    },

    async desbloquear(user, targetUserId) {
      const targetId = String(targetUserId || '').trim();
      if (!targetId) throw httpError(400, 'Usuario inválido');
      await supabaseAdmin
        .from('comunidad_bloqueos')
        .delete()
        .eq('blocker_user_id', user.id)
        .eq('blocked_user_id', targetId);
      return { success: true, blocked: false };
    },

    async usuarioResumen(user, targetUserId) {
      const targetId = String(targetUserId || '').trim();
      if (!targetId) throw httpError(400, 'Usuario inválido');
      await requireTables();
      const perfiles = await loadPerfilesByUserIds(supabaseAdmin, [targetId]);

      const { count: seguidores_count, error: e1 } = await supabaseAdmin
        .from('comunidad_seguimientos')
        .select('*', { count: 'exact', head: true })
        .eq('following_user_id', targetId);
      if (e1) throw schemaUnavailable(e1);
      const { count: seguidos_count, error: e2 } = await supabaseAdmin
        .from('comunidad_seguimientos')
        .select('*', { count: 'exact', head: true })
        .eq('follower_user_id', targetId);
      if (e2) throw schemaUnavailable(e2);

      let following = false;
      let blocked_by_me = false;
      let blocks_me = false;
      if (user?.id) {
        const { data: fol } = await supabaseAdmin
          .from('comunidad_seguimientos')
          .select('id')
          .eq('follower_user_id', user.id)
          .eq('following_user_id', targetId)
          .maybeSingle();
        following = Boolean(fol);
        const { data: b1 } = await supabaseAdmin
          .from('comunidad_bloqueos')
          .select('id')
          .eq('blocker_user_id', user.id)
          .eq('blocked_user_id', targetId)
          .maybeSingle();
        blocked_by_me = Boolean(b1);
        const { data: b2 } = await supabaseAdmin
          .from('comunidad_bloqueos')
          .select('id')
          .eq('blocker_user_id', targetId)
          .eq('blocked_user_id', user.id)
          .maybeSingle();
        blocks_me = Boolean(b2);
      }

      return mapUsuarioResumenDto({
        userId: targetId,
        autor: perfiles.get(targetId) || { user_id: targetId },
        seguidores_count: seguidores_count || 0,
        seguidos_count: seguidos_count || 0,
        following,
        blocked_by_me,
        blocks_me,
      });
    },

    async crearDenuncia(user, body) {
      await requireTables();
      const objeto_tipo = String(body?.objeto_tipo || '').trim().toLowerCase();
      const objeto_id = parsePositiveInt(body?.objeto_id);
      const motivo = sanitizePlainText(body?.motivo, { max: MOTIVO_MAX });
      if (!['publicacion', 'comentario'].includes(objeto_tipo)) {
        throw httpError(400, 'objeto_tipo inválido');
      }
      if (!objeto_id) throw httpError(400, 'objeto_id inválido');
      if (!motivo) throw httpError(400, 'motivo es requerido');

      const { data: existing } = await supabaseAdmin
        .from('comunidad_denuncias')
        .select('id,estado')
        .eq('denunciante_user_id', user.id)
        .eq('objeto_tipo', objeto_tipo)
        .eq('objeto_id', objeto_id)
        .eq('estado', 'pendiente')
        .maybeSingle();
      if (existing) throw httpError(409, 'Ya tenés una denuncia pendiente para este contenido');

      const { data, error } = await supabaseAdmin
        .from('comunidad_denuncias')
        .insert([{
          denunciante_user_id: user.id,
          objeto_tipo,
          objeto_id,
          motivo,
          estado: 'pendiente',
        }])
        .select('id,objeto_tipo,objeto_id,motivo,estado,created_at')
        .single();
      if (error) {
        if (/unique|duplicate/i.test(error.message || '')) {
          throw httpError(409, 'Ya tenés una denuncia pendiente para este contenido');
        }
        throw schemaUnavailable(error);
      }
      return { denuncia: data };
    },

    async listDenunciasAdmin({ estado = 'pendiente', limit = 50 } = {}) {
      await requireTables();
      const lim = parseFeedLimit(limit);
      let q = supabaseAdmin
        .from('comunidad_denuncias')
        .select('id,denunciante_user_id,objeto_tipo,objeto_id,motivo,estado,created_at,revisada_at,revisada_por,resolucion_nota')
        .order('created_at', { ascending: false })
        .limit(lim);
      if (estado) q = q.eq('estado', estado);
      const { data, error } = await q;
      if (error) throw schemaUnavailable(error);
      return { denuncias: data || [] };
    },

    async revisarDenuncia(adminUser, denunciaId, body) {
      const id = parsePositiveInt(denunciaId);
      if (!id) throw httpError(400, 'ID inválido');
      const nextEstado = String(body?.estado || '').trim().toLowerCase();
      if (!['revisada', 'descartada'].includes(nextEstado)) {
        throw httpError(400, 'estado debe ser revisada o descartada');
      }
      const accion = String(body?.accion_contenido || '').trim().toLowerCase(); // ocultar|eliminar|none
      const { data: den, error } = await supabaseAdmin
        .from('comunidad_denuncias')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw schemaUnavailable(error);
      if (!den) throw httpError(404, 'Denuncia no encontrada');
      if (den.estado !== 'pendiente') throw httpError(400, 'La denuncia ya fue resuelta');

      if (accion === 'ocultar' || accion === 'eliminar') {
        if (den.objeto_tipo === 'publicacion') {
          await supabaseAdmin
            .from('comunidad_publicaciones')
            .update({
              estado: accion === 'eliminar' ? 'eliminada' : 'ocultada',
              updated_at: new Date().toISOString(),
            })
            .eq('id', den.objeto_id);
          const { data: pub } = await supabaseAdmin
            .from('comunidad_publicaciones')
            .select('autor_user_id')
            .eq('id', den.objeto_id)
            .maybeSingle();
          if (pub?.autor_user_id) {
            await notifyComunidad(supabaseAdmin, {
              event: 'comunidad_contenido_moderado',
              userId: pub.autor_user_id,
              titulo: 'Contenido moderado',
              mensaje: accion === 'eliminar'
                ? 'Tu publicación fue eliminada por moderación'
                : 'Tu publicación fue ocultada por moderación',
              link: 'padbolmatch://comunidad',
              dedupeParts: { publicacionId: den.objeto_id, accion },
            });
          }
        } else if (den.objeto_tipo === 'comentario') {
          await supabaseAdmin
            .from('comunidad_comentarios')
            .update({
              estado: accion === 'eliminar' ? 'eliminado' : 'ocultado',
              updated_at: new Date().toISOString(),
            })
            .eq('id', den.objeto_id);
        }
      }

      const { data: updated, error: uErr } = await supabaseAdmin
        .from('comunidad_denuncias')
        .update({
          estado: nextEstado,
          revisada_at: new Date().toISOString(),
          revisada_por: adminUser.id,
          resolucion_nota: body?.nota ? sanitizePlainText(body.nota, { max: MOTIVO_MAX }) : null,
        })
        .eq('id', id)
        .select('*')
        .single();
      if (uErr) throw schemaUnavailable(uErr);
      return { denuncia: updated };
    },
  };
}

export { isModeratorRole };
