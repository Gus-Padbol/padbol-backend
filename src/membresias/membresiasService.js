import { createNotificacionIfAbsent } from '../../utils/notificaciones.js';
import {
  applyMembresiaBenefitsToQuote,
  assertAdminSedeScope,
  buildMembresiaJugadorSearchOrFilter,
  buildMembresiaNotificacionDedupeKey,
  buildMembresiasPagination,
  buildPeriodoKey,
  escapeMembresiaIlike,
  httpError,
  isMembershipActive,
  isMissingMembresiaTableError,
  mapJugadorResumenMembresia,
  mapMembresiaJugadorDto,
  mapMembresiaPublica,
  mapPlanPublico,
  normalizeBeneficios,
  normalizeDuracionTipo,
  parseMembresiasListQuery,
  parseNonNegativeNumber,
  parsePositiveInt,
  resolveDuracionDias,
  addDaysIso,
  shouldMarkExpired,
  ORIGENES,
} from '../../lib/membresiasDomain.js';

const MEMBRESIA_LIST_SELECT = [
  'id',
  'user_id',
  'email',
  'sede_id',
  'plan_id',
  'estado',
  'origen',
  'inicio',
  'vencimiento',
  'renovacion_automatica',
  'created_at',
  'updated_at',
].join(', ');

const PLAN_LIST_SELECT = [
  'id',
  'sede_id',
  'nombre',
  'descripcion',
  'precio',
  'moneda',
  'duracion_tipo',
  'duracion_dias',
  'activo',
  'cupo',
  'vigencia_desde',
  'vigencia_hasta',
  'renovacion_automatica',
  'beneficios',
].join(', ');

const JUGADOR_LIST_SELECT = 'user_id, nombre, apellido, username, apodo, alias, email';

function schemaErr(err) {
  if (isMissingMembresiaTableError(err)) {
    return httpError(503, 'Membresías por sede aún no disponibles — migración SQL pendiente');
  }
  return err;
}

async function resolveMembresiaSearchUserIds(supabaseAdmin, { sedeId, q, track = async (_l, run) => run() }) {
  const orFilter = buildMembresiaJugadorSearchOrFilter(q);
  const escaped = escapeMembresiaIlike(q);
  const ids = new Set();

  if (orFilter) {
    const { data, error } = await track('jugadores_search', () =>
      supabaseAdmin
        .from('jugadores_perfil')
        .select('user_id')
        .or(orFilter)
        .limit(300),
    );
    if (error) throw schemaErr(error);
    for (const row of data || []) {
      if (row?.user_id) ids.add(String(row.user_id));
    }
  }

  // También email guardado en la membresía (panel autorizado), acotado a la sede.
  const { data: byEmail, error: emailErr } = await track('membresias_email_search', () =>
    supabaseAdmin
      .from('membresias_sede')
      .select('user_id')
      .eq('sede_id', sedeId)
      .ilike('email', `%${escaped}%`)
      .limit(300),
  );
  if (emailErr) throw schemaErr(emailErr);
  for (const row of byEmail || []) {
    if (row?.user_id) ids.add(String(row.user_id));
  }

  return [...ids];
}

async function expirePageBatch(supabaseAdmin, rows, track = async (_l, run) => run()) {
  const toExpire = (rows || []).filter((r) => shouldMarkExpired(r));
  if (!toExpire.length) return rows || [];

  const ids = toExpire.map((r) => r.id).filter((id) => id != null);
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await track('expire_batch', () =>
    supabaseAdmin
      .from('membresias_sede')
      .update({ estado: 'vencida', updated_at: nowIso })
      .in('id', ids)
      .eq('estado', 'activa')
      .select(MEMBRESIA_LIST_SELECT),
  );
  if (error) throw schemaErr(error);

  const updatedById = new Map((updated || []).map((r) => [Number(r.id), r]));
  // Notificaciones: una por membresía vencida (regla existente); no bloquea el listado.
  for (const row of updated || []) {
    void notifyMembresiaStandalone(supabaseAdmin, {
      event: 'membresia_vencida',
      userId: row.user_id,
      titulo: 'Membresía vencida',
      mensaje: 'Tu membresía venció y ya no aplica beneficios',
      membresiaId: row.id,
      sedeId: row.sede_id,
    });
  }

  return (rows || []).map((row) => {
    const u = updatedById.get(Number(row.id));
    if (u) return u;
    if (shouldMarkExpired(row)) return { ...row, estado: 'vencida' };
    return row;
  });
}

async function notifyMembresiaStandalone(supabaseAdmin, payload) {
  const {
    event,
    userId,
    titulo,
    mensaje,
    membresiaId,
    sedeId,
  } = payload;
  if (!userId) return;
  const dedupe_key = buildMembresiaNotificacionDedupeKey(event, {
    membresiaId,
    sedeId,
    userId,
  });
  try {
    await createNotificacionIfAbsent(supabaseAdmin, {
      user_id: userId,
      tipo: event,
      titulo,
      mensaje,
      link: `padbolmatch://membresias`,
      data: {
        dedupe_key,
        tipo: event,
        membresia_id: membresiaId != null ? String(membresiaId) : null,
        sede_id: sedeId != null ? String(sedeId) : null,
        navegacion: { screen: 'Membresia', params: { sedeId, membresiaId } },
      },
    });
  } catch (err) {
    console.warn(`⚠️ notif membresia ${event}:`, err.message);
  }
}

async function loadPlansBatch(supabaseAdmin, planIds, track = async (_l, run) => run()) {
  const ids = [...new Set((planIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const { data, error } = await track('planes_batch', () =>
    supabaseAdmin
      .from('membresia_planes')
      .select(PLAN_LIST_SELECT)
      .in('id', ids),
  );
  if (error) throw schemaErr(error);
  return new Map((data || []).map((p) => [Number(p.id), p]));
}

async function loadJugadoresBatch(supabaseAdmin, userIds, track = async (_l, run) => run()) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const { data, error } = await track('jugadores_batch', () =>
    supabaseAdmin
      .from('jugadores_perfil')
      .select(JUGADOR_LIST_SELECT)
      .in('user_id', ids),
  );
  if (error) throw schemaErr(error);
  const map = new Map();
  for (const row of data || []) {
    map.set(String(row.user_id), mapJugadorResumenMembresia(row));
  }
  return map;
}

async function setEstado(supabaseAdmin, role, membresiaId, estado, event, titulo, loadPlan) {
  const id = parsePositiveInt(membresiaId);
  if (!id) throw httpError(400, 'ID inválido');
  const { data: row, error } = await supabaseAdmin
    .from('membresias_sede')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw schemaErr(error);
  if (!row) throw httpError(404, 'Membresía no encontrada');
  const scopeErr = assertAdminSedeScope(role, row.sede_id);
  if (scopeErr) throw scopeErr;
  if (row.estado === 'cancelada' && estado !== 'cancelada') {
    throw httpError(400, 'La membresía cancelada no se reabre desde este endpoint');
  }

  const patch = {
    estado,
    updated_at: new Date().toISOString(),
  };
  if (estado === 'suspendida') patch.suspendida_at = new Date().toISOString();
  if (estado === 'cancelada') patch.cancelada_at = new Date().toISOString();

  const { data, error: uErr } = await supabaseAdmin
    .from('membresias_sede')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (uErr) throw schemaErr(uErr);

  await notifyMembresia(supabaseAdmin, {
    event,
    userId: data.user_id,
    titulo,
    mensaje: titulo,
    membresiaId: data.id,
    sedeId: data.sede_id,
  });

  const plan = await loadPlan(data.plan_id);
  return mapMembresiaPublica(data, plan);
}

async function notifyMembresia(supabaseAdmin, {
  event,
  userId,
  titulo,
  mensaje,
  membresiaId,
  sedeId,
}) {
  if (!userId) return;
  const dedupe_key = buildMembresiaNotificacionDedupeKey(event, {
    membresiaId,
    sedeId,
    userId,
  });
  try {
    await createNotificacionIfAbsent(supabaseAdmin, {
      user_id: userId,
      tipo: event,
      titulo,
      mensaje,
      link: `padbolmatch://membresias`,
      data: {
        dedupe_key,
        tipo: event,
        membresia_id: membresiaId != null ? String(membresiaId) : null,
        sede_id: sedeId != null ? String(sedeId) : null,
        navegacion: { screen: 'Membresia', params: { sedeId, membresiaId } },
      },
    });
  } catch (err) {
    console.warn(`⚠️ notif membresia ${event}:`, err.message);
  }
}

export function createMembresiasSedeService({ supabaseAdmin }) {
  async function loadPlan(planId) {
    const id = parsePositiveInt(planId);
    if (!id) return null;
    const { data, error } = await supabaseAdmin
      .from('membresia_planes')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw schemaErr(error);
    return data;
  }

  async function expireIfNeeded(row) {
    if (!shouldMarkExpired(row)) return row;
    const { data, error } = await supabaseAdmin
      .from('membresias_sede')
      .update({ estado: 'vencida', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('estado', 'activa')
      .select('*')
      .maybeSingle();
    if (error) throw schemaErr(error);
    if (data) {
      await notifyMembresia(supabaseAdmin, {
        event: 'membresia_vencida',
        userId: data.user_id,
        titulo: 'Membresía vencida',
        mensaje: 'Tu membresía venció y ya no aplica beneficios',
        membresiaId: data.id,
        sedeId: data.sede_id,
      });
      return data;
    }
    return { ...row, estado: 'vencida' };
  }

  async function countUsosPeriodo(membresia, beneficio = 'reservas_incluidas_por_periodo') {
    const periodo_key = buildPeriodoKey(membresia);
    const { count, error } = await supabaseAdmin
      .from('membresia_usos_reserva')
      .select('*', { count: 'exact', head: true })
      .eq('membresia_id', membresia.id)
      .eq('periodo_key', periodo_key)
      .eq('beneficio', beneficio);
    if (error) throw schemaErr(error);
    return count ?? 0;
  }

  return {
    async listPlanesAdmin(role, { sedeId, includeInactive = true } = {}) {
      const sid = parsePositiveInt(sedeId);
      if (!sid) throw httpError(400, 'sede_id es requerido');
      const scopeErr = assertAdminSedeScope(role, sid);
      if (scopeErr) throw scopeErr;
      let q = supabaseAdmin
        .from('membresia_planes')
        .select('*')
        .eq('sede_id', sid)
        .order('id', { ascending: false });
      if (!includeInactive) q = q.eq('activo', true);
      const { data, error } = await q;
      if (error) throw schemaErr(error);
      return { planes: (data || []).map(mapPlanPublico) };
    },

    async listPlanesPublicos(sedeId) {
      const sid = parsePositiveInt(sedeId);
      if (!sid) throw httpError(400, 'sedeId inválido');
      const { data, error } = await supabaseAdmin
        .from('membresia_planes')
        .select('*')
        .eq('sede_id', sid)
        .eq('activo', true)
        .order('precio', { ascending: true });
      if (error) throw schemaErr(error);
      const now = new Date();
      const planes = (data || []).filter((p) => {
        if (p.vigencia_desde && new Date(p.vigencia_desde) > now) return false;
        if (p.vigencia_hasta && new Date(p.vigencia_hasta) < now) return false;
        return true;
      }).map(mapPlanPublico);
      return { planes };
    },

    async createPlan(role, body, adminUser) {
      const sid = parsePositiveInt(body?.sede_id);
      if (!sid) throw httpError(400, 'sede_id es requerido');
      const scopeErr = assertAdminSedeScope(role, sid);
      if (scopeErr) throw scopeErr;
      const nombre = String(body?.nombre ?? '').trim();
      if (!nombre) throw httpError(400, 'nombre es requerido');
      const duracion_tipo = normalizeDuracionTipo(body?.duracion_tipo, 'mensual');
      const duracion_dias = resolveDuracionDias({
        duracion_tipo,
        duracion_dias: body?.duracion_dias,
      });
      const precio = parseNonNegativeNumber(body?.precio ?? 0);
      if (precio == null) throw httpError(400, 'precio inválido');
      const now = new Date().toISOString();
      const row = {
        sede_id: sid,
        nombre,
        descripcion: body?.descripcion ? String(body.descripcion).trim().slice(0, 2000) : null,
        precio,
        moneda: String(body?.moneda || 'ARS').trim().toUpperCase() || 'ARS',
        duracion_tipo,
        duracion_dias,
        activo: body?.activo !== false,
        cupo: body?.cupo != null ? parsePositiveInt(body.cupo) : null,
        vigencia_desde: body?.vigencia_desde || null,
        vigencia_hasta: body?.vigencia_hasta || null,
        renovacion_automatica: Boolean(body?.renovacion_automatica),
        beneficios: normalizeBeneficios(body?.beneficios || {}),
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await supabaseAdmin
        .from('membresia_planes')
        .insert([row])
        .select('*')
        .single();
      if (error) throw schemaErr(error);
      return mapPlanPublico(data);
    },

    async updatePlan(role, planId, body) {
      const plan = await loadPlan(planId);
      if (!plan) throw httpError(404, 'Plan no encontrado');
      const scopeErr = assertAdminSedeScope(role, plan.sede_id);
      if (scopeErr) throw scopeErr;

      const patch = { updated_at: new Date().toISOString() };
      if (body?.nombre != null) {
        const nombre = String(body.nombre).trim();
        if (!nombre) throw httpError(400, 'nombre inválido');
        patch.nombre = nombre;
      }
      if (body?.descripcion !== undefined) {
        patch.descripcion = body.descripcion ? String(body.descripcion).trim().slice(0, 2000) : null;
      }
      if (body?.precio != null) {
        const precio = parseNonNegativeNumber(body.precio);
        if (precio == null) throw httpError(400, 'precio inválido');
        patch.precio = precio;
      }
      if (body?.moneda != null) patch.moneda = String(body.moneda).trim().toUpperCase();
      if (body?.duracion_tipo != null || body?.duracion_dias != null) {
        const duracion_tipo = normalizeDuracionTipo(body.duracion_tipo ?? plan.duracion_tipo);
        patch.duracion_tipo = duracion_tipo;
        patch.duracion_dias = resolveDuracionDias({
          duracion_tipo,
          duracion_dias: body.duracion_dias ?? plan.duracion_dias,
        });
      }
      if (body?.activo != null) patch.activo = Boolean(body.activo);
      if (body?.cupo !== undefined) patch.cupo = body.cupo == null ? null : parsePositiveInt(body.cupo);
      if (body?.vigencia_desde !== undefined) patch.vigencia_desde = body.vigencia_desde || null;
      if (body?.vigencia_hasta !== undefined) patch.vigencia_hasta = body.vigencia_hasta || null;
      if (body?.renovacion_automatica != null) patch.renovacion_automatica = Boolean(body.renovacion_automatica);
      if (body?.beneficios != null) patch.beneficios = normalizeBeneficios(body.beneficios);

      const { data, error } = await supabaseAdmin
        .from('membresia_planes')
        .update(patch)
        .eq('id', plan.id)
        .select('*')
        .single();
      if (error) throw schemaErr(error);
      return mapPlanPublico(data);
    },

    async listMembresiasAdmin(role, {
      sedeId,
      estado,
      plan_id,
      q,
      page,
      limit,
      sort,
      direction,
      tracker = null,
    } = {}) {
      const sid = parsePositiveInt(sedeId);
      if (!sid) throw httpError(400, 'sede_id es requerido');
      const scopeErr = assertAdminSedeScope(role, sid);
      if (scopeErr) throw scopeErr;

      const parsed = parseMembresiasListQuery({
        estado,
        plan_id,
        q,
        page,
        limit,
        sort,
        direction,
      });

      const track = async (label, run) => {
        if (tracker?.queries) tracker.queries.push(label);
        return run();
      };

      // Validar plan_id pertenece a la sede (1 query opcional).
      if (parsed.planId) {
        const { data: planRow, error: planErr } = await track('plan_scope', () =>
          supabaseAdmin
            .from('membresia_planes')
            .select('id, sede_id')
            .eq('id', parsed.planId)
            .maybeSingle(),
        );
        if (planErr) throw schemaErr(planErr);
        if (!planRow || Number(planRow.sede_id) !== sid) {
          throw httpError(400, 'plan_id no pertenece a esta sede');
        }
      }

      // Búsqueda q → user_ids (consultas acotadas, no N+1).
      let searchUserIds = null;
      if (parsed.q) {
        searchUserIds = await resolveMembresiaSearchUserIds(supabaseAdmin, {
          sedeId: sid,
          q: parsed.q,
          track,
        });
        if (searchUserIds.length === 0) {
          return {
            membresias: [],
            pagination: buildMembresiasPagination({
              page: parsed.page,
              limit: parsed.limit,
              total: 0,
            }),
          };
        }
      }

      let listQuery = supabaseAdmin
        .from('membresias_sede')
        .select(MEMBRESIA_LIST_SELECT, { count: 'exact' })
        .eq('sede_id', sid)
        .order(parsed.sort, { ascending: parsed.direction === 'asc' })
        .range(parsed.offset, parsed.offset + parsed.limit - 1);

      if (parsed.estado) listQuery = listQuery.eq('estado', parsed.estado);
      if (parsed.planId) listQuery = listQuery.eq('plan_id', parsed.planId);
      if (searchUserIds) listQuery = listQuery.in('user_id', searchUserIds);

      const { data, error, count } = await track('membresias_page', () => listQuery);
      if (error) throw schemaErr(error);

      const total = Number.isFinite(count) ? count : (data || []).length;
      let rows = Array.isArray(data) ? data : [];

      // Vencimiento lazy en batch (misma regla, sin update por fila de planes).
      rows = await expirePageBatch(supabaseAdmin, rows, track);

      const planIds = [...new Set(rows.map((r) => r.plan_id).filter((id) => id != null))];
      const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean).map(String))];

      const [planMap, jugadorMap] = await Promise.all([
        loadPlansBatch(supabaseAdmin, planIds, track),
        loadJugadoresBatch(supabaseAdmin, userIds, track),
      ]);

      const membresias = rows.map((row) =>
        mapMembresiaPublica(
          row,
          planMap.get(Number(row.plan_id)) || null,
          jugadorMap.get(String(row.user_id)) || null,
        ),
      );

      return {
        membresias,
        pagination: buildMembresiasPagination({
          page: parsed.page,
          limit: parsed.limit,
          total,
        }),
      };
    },

    async asignar(role, body, adminUser) {
      const sid = parsePositiveInt(body?.sede_id);
      const planId = parsePositiveInt(body?.plan_id);
      const userId = String(body?.user_id || '').trim();
      if (!sid || !planId || !userId) throw httpError(400, 'sede_id, plan_id y user_id son requeridos');
      const scopeErr = assertAdminSedeScope(role, sid);
      if (scopeErr) throw scopeErr;

      const plan = await loadPlan(planId);
      if (!plan || Number(plan.sede_id) !== sid) throw httpError(404, 'Plan no encontrado para esta sede');
      if (plan.activo === false) throw httpError(400, 'El plan está inactivo');

      const origen = ORIGENES.includes(String(body?.origen || '').toLowerCase())
        ? String(body.origen).toLowerCase()
        : 'manual';
      const inicio = body?.inicio ? new Date(body.inicio).toISOString() : new Date().toISOString();
      let vencimiento = body?.vencimiento
        ? new Date(body.vencimiento).toISOString()
        : addDaysIso(inicio, resolveDuracionDias(plan));
      if (new Date(vencimiento) <= new Date(inicio)) {
        throw httpError(400, 'vencimiento debe ser posterior a inicio');
      }

      // Soft-cancel overlapping active for unique index
      const { data: existingActivas } = await supabaseAdmin
        .from('membresias_sede')
        .select('id')
        .eq('user_id', userId)
        .eq('sede_id', sid)
        .eq('estado', 'activa');
      if ((existingActivas || []).length) {
        await supabaseAdmin
          .from('membresias_sede')
          .update({
            estado: 'cancelada',
            cancelada_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            notas: 'Reemplazada por nueva asignación',
          })
          .in('id', existingActivas.map((r) => r.id));
      }

      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('membresias_sede')
        .insert([{
          user_id: userId,
          email: body?.email ? String(body.email).trim().toLowerCase() : null,
          sede_id: sid,
          plan_id: planId,
          estado: 'activa',
          origen,
          inicio,
          vencimiento,
          renovacion_automatica: Boolean(body?.renovacion_automatica ?? plan.renovacion_automatica),
          notas: body?.notas ? String(body.notas).trim().slice(0, 1000) : null,
          created_by: adminUser?.id || null,
          created_at: now,
          updated_at: now,
        }])
        .select('*')
        .single();
      if (error) throw schemaErr(error);

      await notifyMembresia(supabaseAdmin, {
        event: 'membresia_activada',
        userId,
        titulo: 'Membresía activada',
        mensaje: `Tu plan ${plan.nombre} está activo`,
        membresiaId: data.id,
        sedeId: sid,
      });

      return mapMembresiaPublica(data, plan);
    },

    async renovar(role, membresiaId, body = {}) {
      const id = parsePositiveInt(membresiaId);
      if (!id) throw httpError(400, 'ID inválido');
      const { data: row, error } = await supabaseAdmin
        .from('membresias_sede')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw schemaErr(error);
      if (!row) throw httpError(404, 'Membresía no encontrada');
      const scopeErr = assertAdminSedeScope(role, row.sede_id);
      if (scopeErr) throw scopeErr;

      const plan = await loadPlan(row.plan_id);
      if (!plan) throw httpError(404, 'Plan no encontrado');

      const baseInicio = body?.inicio
        ? new Date(body.inicio)
        : new Date(Math.max(Date.now(), new Date(row.vencimiento).getTime()));
      const inicio = baseInicio.toISOString();
      const dias = resolveDuracionDias(plan);
      const vencimiento = body?.vencimiento
        ? new Date(body.vencimiento).toISOString()
        : addDaysIso(inicio, dias);

      // Continuidad: cancelar actual y crear nueva activa (sin solapar unique)
      await supabaseAdmin
        .from('membresias_sede')
        .update({
          estado: 'cancelada',
          cancelada_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          notas: 'Renovada',
        })
        .eq('id', id);

      const now = new Date().toISOString();
      const { data: neu, error: iErr } = await supabaseAdmin
        .from('membresias_sede')
        .insert([{
          user_id: row.user_id,
          email: row.email,
          sede_id: row.sede_id,
          plan_id: row.plan_id,
          estado: 'activa',
          origen: row.origen || 'manual',
          inicio,
          vencimiento,
          renovacion_automatica: row.renovacion_automatica,
          notas: `Renovación de #${id}`,
          created_at: now,
          updated_at: now,
        }])
        .select('*')
        .single();
      if (iErr) throw schemaErr(iErr);

      await notifyMembresia(supabaseAdmin, {
        event: 'membresia_renovada',
        userId: neu.user_id,
        titulo: 'Membresía renovada',
        mensaje: 'Tu membresía fue renovada',
        membresiaId: neu.id,
        sedeId: neu.sede_id,
      });

      return mapMembresiaPublica(neu, plan);
    },

    async suspender(role, membresiaId) {
      return setEstado(supabaseAdmin, role, membresiaId, 'suspendida', 'membresia_suspendida', 'Membresía suspendida', loadPlan);
    },

    async cancelar(role, membresiaId) {
      return setEstado(supabaseAdmin, role, membresiaId, 'cancelada', 'membresia_cancelada', 'Membresía cancelada', loadPlan);
    },

    async listJugador(user) {
      const { data, error } = await supabaseAdmin
        .from('membresias_sede')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw schemaErr(error);
      const out = [];
      for (const row of data || []) {
        const expired = await expireIfNeeded(row);
        const plan = await loadPlan(expired.plan_id);
        out.push(mapMembresiaJugadorDto(expired, plan));
      }
      return { membresias: out };
    },

    /**
     * Resuelve membresía activa aplicable a sede (lazy expiry).
     */
    async resolveActivaForReserva({ userId, email, sedeId }) {
      if (!sedeId) return null;
      let q = supabaseAdmin
        .from('membresias_sede')
        .select('*')
        .eq('sede_id', sedeId)
        .eq('estado', 'activa')
        .order('vencimiento', { ascending: false })
        .limit(5);
      if (userId) q = q.eq('user_id', userId);
      else if (email) q = q.eq('email', String(email).trim().toLowerCase());
      else return null;

      const { data, error } = await q;
      if (error) {
        if (isMissingMembresiaTableError(error)) return null;
        throw schemaErr(error);
      }
      for (const row of data || []) {
        const current = await expireIfNeeded(row);
        if (isMembershipActive(current)) {
          const plan = await loadPlan(current.plan_id);
          const usadas = await countUsosPeriodo(current);
          return { membresia: current, plan, incluidasUsadas: usadas };
        }
      }
      return null;
    },

    async registerUsoReservaIncluida({
      membresiaId,
      userId,
      sedeId,
      reservaId,
      detalle = {},
    }) {
      if (!membresiaId || !reservaId) return { created: false };
      const { data: mem } = await supabaseAdmin
        .from('membresias_sede')
        .select('*')
        .eq('id', membresiaId)
        .maybeSingle();
      if (!mem) return { created: false };
      const periodo_key = buildPeriodoKey(mem);
      const { data, error } = await supabaseAdmin
        .from('membresia_usos_reserva')
        .insert([{
          membresia_id: membresiaId,
          user_id: userId,
          sede_id: sedeId,
          reserva_id: reservaId,
          periodo_key,
          beneficio: 'reservas_incluidas_por_periodo',
          detalle,
        }])
        .select('id')
        .maybeSingle();
      if (error) {
        if (/unique|duplicate/i.test(error.message || '')) {
          return { created: false, idempotent: true };
        }
        throw schemaErr(error);
      }
      return { created: true, id: data?.id };
    },

    applyBenefitsToQuoteAmounts: applyMembresiaBenefitsToQuote,
  };
}

export { applyMembresiaBenefitsToQuote, notifyMembresia };
