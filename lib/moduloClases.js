/**
 * Rutas y helpers del módulo clases (registrados desde server.js).
 * Escrituras vía supabaseAdmin (service role).
 */

const ESTADOS_INSCRIPCION_CUENTAN_CUPO = new Set(['pendiente', 'confirmada', 'pagada']);

/** Columnas de profesor en respuestas públicas (nunca whatsapp). */
const PROFESOR_PUBLIC_SELECT =
  'id, nombre, apellido, foto_url, bio, deportes, especialidad, nivel, certificado_fipa, certificado_estado';
/** Join en clases: aprobado/activo solo para filtros en query, no se exponen al cliente. */
const PROFESOR_JOIN_PUBLIC_SELECT = `${PROFESOR_PUBLIC_SELECT}, aprobado, activo`;

const PROFESOR_ADMIN_DETAIL_SELECT =
  'id, sede_id, nombre, apellido, foto_url, bio, deportes, especialidad, nivel, certificado_fipa, certificado_numero, certificado_url, certificado_estado, certificado_nota, certificado_verificado_at, certificado_verificado_por, whatsapp, fecha_nacimiento, genero, aprobado, aprobado_por, activo, created_at, updated_at, user_id, sedes(id, nombre)';

const GENERO_INSTRUCTOR_VALIDOS = new Set(['masculino', 'femenino', 'no_decir']);

export function registerModuloClasesRoutes(app, deps) {
  const {
    supabase,
    supabaseAdmin,
    authUserFromBearer,
    adminListScopeFromRequest,
    assertUsuarioPuedeAdministrarSede,
    assertSuperAdminReq,
    canchasConNumeroReserva,
    assertReservaSinSolapeBackend,
  } = deps;

  function normalizeHoraClase(raw) {
    const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const hh = Math.min(23, parseInt(m[1], 10));
    const mm = Math.min(59, parseInt(m[2], 10));
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function normalizeFechaYmd(raw) {
    const s = String(raw || '').trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  function diaSemanaFromFechaYmd(ymd) {
    const [y, mo, d] = ymd.split('-').map((x) => parseInt(x, 10));
    const dt = new Date(y, mo - 1, d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.getDay();
  }

  function mapProfesorPublic(row) {
    if (!row) return null;
    const nombre =
      [String(row.nombre || '').trim(), String(row.apellido || '').trim()].filter(Boolean).join(' ').trim() ||
      String(row.nombre || '').trim();
    return {
      id: row.id,
      nombre,
      foto_url: row.foto_url ?? null,
      bio: row.bio ?? null,
      deportes: Array.isArray(row.deportes) ? row.deportes : [],
      certificado_fipa:
        Boolean(row.certificado_fipa) && String(row.certificado_estado || 'sin_documento') === 'aprobado',
      especialidad: row.especialidad ?? null,
      nivel: row.nivel ?? null,
    };
  }

  function profesorMatchesDeporte(profesorRow, deporteFilter) {
    const dep = String(deporteFilter || '').trim().toLowerCase();
    if (!dep) return true;
    const list = Array.isArray(profesorRow?.deportes) ? profesorRow.deportes : [];
    return list.some((d) => String(d || '').trim().toLowerCase() === dep);
  }

  async function requireAuthUser(req) {
    const user = await authUserFromBearer(req);
    if (!user?.id) {
      const e = new Error('No autorizado');
      e.status = 401;
      throw e;
    }
    return user;
  }

  function normalizeGeneroInstructor(raw) {
    const g = String(raw || '').trim().toLowerCase();
    if (g === 'masculino' || g === 'femenino') return g;
    if (g === 'no_decir' || g === 'prefiero_no_decir' || g === 'prefiero no decir' || g === 'otro') {
      return 'no_decir';
    }
    return null;
  }

  function mapProfesorAdminRow(p) {
    if (!p) return null;
    const sede = p.sedes;
    const { sedes: _s, ...rest } = p;
    return { ...rest, sede_nombre: sede?.nombre ?? null };
  }

  async function assertAdminClubOrSuper(req) {
    const scope = await adminListScopeFromRequest(req);
    if (!scope) {
      const e = new Error('No autorizado');
      e.status = 401;
      throw e;
    }
    const rol = String(scope.rol || '').trim().toLowerCase();
    if (scope.superA || ['admin_club', 'admin_nacional', 'empleado'].includes(rol)) return scope;
    const e = new Error('No tienes permiso de administración de club');
    e.status = 403;
    throw e;
  }

  async function countInscripcionesSlot(claseId, fecha, horaInicio) {
    const { data, error } = await supabaseAdmin
      .from('inscripciones_clases')
      .select('id, estado, hora_inicio')
      .eq('clase_id', claseId)
      .eq('fecha', fecha);
    if (error) throw error;
    return (data || []).filter(
      (r) =>
        ESTADOS_INSCRIPCION_CUENTAN_CUPO.has(String(r.estado || '').toLowerCase()) &&
        normalizeHoraClase(r.hora_inicio) === horaInicio,
    ).length;
  }

  async function fetchHorariosClase(claseId) {
    const { data, error } = await supabaseAdmin
      .from('clases_horarios')
      .select('id, clase_id, dia_semana, hora_inicio, hora_fin')
      .eq('clase_id', claseId)
      .order('dia_semana', { ascending: true })
      .order('hora_inicio', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  function horarioMatchesSlot(horarios, fecha, horaInicio) {
    const dia = diaSemanaFromFechaYmd(fecha);
    if (dia == null) return false;
    return (horarios || []).some(
      (h) => Number(h.dia_semana) === dia && normalizeHoraClase(h.hora_inicio) === horaInicio,
    );
  }

  async function resolveCanchaNumeroReserva(canchaId) {
    const cid = Number(canchaId);
    if (!Number.isFinite(cid)) return null;
    const { data, error } = await supabaseAdmin.from('canchas').select('*').eq('id', cid).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const [enriched] = canchasConNumeroReserva([data]);
    return enriched?.numero_reserva ?? null;
  }

  async function mapClaseListItem(claseRow, horarios) {
    const prof = mapProfesorPublic(claseRow.profesores);
    const { profesores: _profesoresJoin, whatsapp: _wa, ...rest } = claseRow;
    return {
      ...rest,
      profesor: prof,
      horarios: horarios || [],
    };
  }

  async function registrarEventoInternoClase({ sedeId, claseId = null, inscripcionId = null, userId = null, tipo, payload = {} }) {
    try {
      const { error } = await supabaseAdmin.from('clases_eventos_internos').insert([{
        sede_id: sedeId,
        clase_id: claseId,
        inscripcion_id: inscripcionId,
        user_id: userId,
        tipo,
        payload,
      }]);
      if (error) console.warn('Clases: no se pudo registrar evento interno:', error.message);
    } catch (error) {
      console.warn('Clases: evento interno omitido:', error?.message || error);
    }
  }

  function msHastaInicioClase(fechaYmd, horaInicio) {
    const hi = normalizeHoraClase(horaInicio);
    if (!fechaYmd || !hi) return null;
    const start = new Date(`${fechaYmd}T${hi}:00-03:00`);
    if (Number.isNaN(start.getTime())) return null;
    return start.getTime() - Date.now();
  }

  function evalPoliticaCancelacion(claseRow, inscripcionRow) {
    const horas = parseInt(String(claseRow?.horas_cancelacion ?? 24), 10);
    const h = Number.isFinite(horas) && horas >= 0 ? horas : 24;
    const ms = msHastaInicioClase(inscripcionRow?.fecha, inscripcionRow?.hora_inicio);
    if (ms == null) {
      return { ok: false, motivo: 'Fecha u horario inválidos', horas_cancelacion: h };
    }
    if (ms < h * 60 * 60 * 1000) {
      return {
        ok: false,
        motivo: `No se puede cancelar con menos de ${h} horas de anticipación`,
        horas_cancelacion: h,
      };
    }
    return { ok: true, horas_cancelacion: h };
  }

  async function perfilContactoPorUserIds(userIds) {
    const map = new Map();
    const uids = [...new Set(userIds.filter(Boolean))];
    if (!uids.length) return map;
    const { data: perfiles, error: pErr } = await supabase
      .from('jugadores_perfil')
      .select('user_id, nombre, apellido, apodo, email, whatsapp')
      .in('user_id', uids);
    if (pErr) throw pErr;
    for (const p of perfiles || []) {
      const uid = String(p.user_id || '');
      if (!uid) continue;
      const nombre =
        [p.nombre, p.apellido].filter(Boolean).join(' ').trim() ||
        String(p.apodo || '').trim() ||
        String(p.email || '').split('@')[0] ||
        '—';
      map.set(uid, {
        nombre,
        email: String(p.email || '').trim().toLowerCase() || null,
        telefono: String(p.whatsapp || '').trim() || null,
      });
    }
    return map;
  }

  /** GET /api/clases?sede_id=&deporte= */
  app.get('/api/clases', async (req, res) => {
    try {
      const sedeId = Number(req.query.sede_id);
      const deporte = String(req.query.deporte || '').trim().toLowerCase();
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id requerido' });

      let q = supabaseAdmin
        .from('clases')
        .select(
          `id, sede_id, profesor_id, cancha_id, deporte, titulo, descripcion, tipo, cupo_maximo, duracion_minutos, precio, activo, profesores!inner(${PROFESOR_JOIN_PUBLIC_SELECT})`,
        )
        .eq('sede_id', sedeId)
        .eq('activo', true)
        .eq('profesores.aprobado', true)
        .eq('profesores.activo', true);

      if (deporte) q = q.ilike('deporte', deporte);

      const { data, error } = await q.order('titulo', { ascending: true });
      if (error) throw error;

      const rows = (data || []).filter((c) => profesorMatchesDeporte(c.profesores, deporte));
      const out = await Promise.all(
        rows.map(async (c) => {
          const horarios = await fetchHorariosClase(c.id);
          const { profesores, ...rest } = c;
          return mapClaseListItem({ ...rest, profesores }, horarios);
        }),
      );
      res.json(out);
    } catch (err) {
      console.error('❌ GET /api/clases:', err?.message || err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  /** GET /api/clases/:id?fecha=YYYY-MM-DD */
  app.get('/api/clases/:id', async (req, res) => {
    try {
      const claseId = Number(req.params.id);
      if (!Number.isFinite(claseId)) return res.status(400).json({ error: 'ID inválido' });
      const fecha = normalizeFechaYmd(req.query.fecha);

      const { data: clase, error } = await supabaseAdmin
        .from('clases')
        .select(
          `id, sede_id, profesor_id, cancha_id, deporte, titulo, descripcion, tipo, cupo_maximo, duracion_minutos, precio, activo, horas_cancelacion, profesores!inner(${PROFESOR_JOIN_PUBLIC_SELECT})`,
        )
        .eq('id', claseId)
        .eq('activo', true)
        .eq('profesores.aprobado', true)
        .eq('profesores.activo', true)
        .maybeSingle();
      if (error) throw error;
      if (!clase) return res.status(404).json({ error: 'Clase no encontrada' });

      const authUser = await authUserFromBearer(req);
      let mi_inscripcion = null;
      if (authUser?.id && fecha) {
        const { data: insMine, error: insMineErr } = await supabaseAdmin
          .from('inscripciones_clases')
          .select('id, clase_id, fecha, hora_inicio, estado, reserva_id, asistio, created_at')
          .eq('clase_id', claseId)
          .eq('user_id', authUser.id)
          .eq('fecha', fecha)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (insMineErr) throw insMineErr;
        if (insMine && !['cancelada'].includes(String(insMine.estado || '').toLowerCase())) {
          mi_inscripcion = insMine;
        }
      }

      const horarios = await fetchHorariosClase(claseId);
      const cupoMax = Math.max(1, parseInt(String(clase.cupo_maximo), 10) || 1);
      let inscriptos = null;
      let cuposPorHorario = null;
      if (fecha) {
        const { data: ins, error: insErr } = await supabaseAdmin
          .from('inscripciones_clases')
          .select('id, estado, hora_inicio')
          .eq('clase_id', claseId)
          .eq('fecha', fecha);
        if (insErr) throw insErr;
        const activas = (ins || []).filter((r) =>
          ESTADOS_INSCRIPCION_CUENTAN_CUPO.has(String(r.estado || '').toLowerCase()),
        );
        inscriptos = activas.length;
        const byHora = {};
        for (const r of activas) {
          const h = normalizeHoraClase(r.hora_inicio);
          if (h) byHora[h] = (byHora[h] || 0) + 1;
        }
        const dia = diaSemanaFromFechaYmd(fecha);
        cuposPorHorario = (horarios || [])
          .filter((h) => Number(h.dia_semana) === dia)
          .map((h) => {
            const hi = normalizeHoraClase(h.hora_inicio);
            const ins = byHora[hi] || 0;
            return {
              hora_inicio: hi,
              hora_fin: normalizeHoraClase(h.hora_fin),
              inscriptos: ins,
              cupos_restantes: Math.max(0, cupoMax - ins),
            };
          });
      }

      const { profesores, ...rest } = clase;
      res.json({
        ...(await mapClaseListItem({ ...rest, profesores }, horarios)),
        inscriptos,
        cupos_por_horario: cuposPorHorario,
        fecha_consultada: fecha,
        horas_cancelacion: parseInt(String(clase.horas_cancelacion ?? 24), 10) || 24,
        mi_inscripcion,
      });
    } catch (err) {
      console.error('❌ GET /api/clases/:id:', err?.message || err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  /** GET /api/jugador/mis-clases — inscripciones del usuario autenticado */
  app.get('/api/jugador/mis-clases', async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const { data: rows, error } = await supabaseAdmin
        .from('inscripciones_clases')
        .select(
          'id, clase_id, user_id, fecha, hora_inicio, estado, reserva_id, asistio, asistencia_marcada_at, created_at, clases!inner(id, titulo, deporte, sede_id, sedes(id, nombre), profesores!inner(id, nombre, apellido))',
        )
        .eq('user_id', user.id)
        .neq('estado', 'cancelada')
        .order('fecha', { ascending: false })
        .order('hora_inicio', { ascending: true })
        .limit(200);
      if (error) throw error;

      const list = (rows || []).map((row) => {
        const clase = row.clases || {};
        const prof = clase.profesores || {};
        const sede = clase.sedes || {};
        const profesor_nombre =
          [prof.nombre, prof.apellido].filter(Boolean).join(' ').trim() || prof.nombre || '—';
        const { clases: _c, ...ins } = row;
        return {
          ...ins,
          clase_titulo: clase.titulo || '—',
          clase_deporte: clase.deporte || null,
          profesor_nombre,
          sede_nombre: sede.nombre || null,
          sede_id: clase.sede_id ?? null,
          hora_inicio: normalizeHoraClase(row.hora_inicio) || row.hora_inicio,
        };
      });
      res.json(list);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/jugador/mis-clases:', err?.message || err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  /** DELETE /api/clases/inscripcion/:inscripcion_id — cancelar inscripción (dueño) */
  app.delete('/api/clases/inscripcion/:inscripcion_id', async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const insId = Number(req.params.inscripcion_id);
      if (!Number.isFinite(insId)) return res.status(400).json({ error: 'ID inválido' });

      const { data: ins, error: insErr } = await supabaseAdmin
        .from('inscripciones_clases')
        .select('id, clase_id, user_id, fecha, hora_inicio, estado, reserva_id')
        .eq('id', insId)
        .maybeSingle();
      if (insErr) throw insErr;
      if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada' });
      if (String(ins.user_id || '') !== String(user.id)) {
        return res.status(403).json({ error: 'No podés cancelar esta inscripción' });
      }
      if (String(ins.estado || '').toLowerCase() === 'cancelada') {
        return res.json({ ok: true, ya_cancelada: true });
      }

      const { data: clase, error: claseErr } = await supabase
        .from('clases')
        .select('id, horas_cancelacion')
        .eq('id', ins.clase_id)
        .maybeSingle();
      if (claseErr) throw claseErr;
      if (!clase) return res.status(404).json({ error: 'Clase no encontrada' });

      const pol = evalPoliticaCancelacion(clase, ins);
      if (!pol.ok) {
        return res.status(400).json({
          error: pol.motivo,
          horas_cancelacion: pol.horas_cancelacion,
        });
      }

      const { error: delErr } = await supabaseAdmin.from('inscripciones_clases').delete().eq('id', insId);
      if (delErr) throw delErr;

      if (ins.reserva_id != null) {
        await supabaseAdmin
          .from('reservas')
          .update({ estado: 'cancelada' })
          .eq('id', ins.reserva_id);
      }

      await registrarEventoInternoClase({
        sedeId: clase.sede_id,
        claseId: ins.clase_id,
        userId: user.id,
        tipo: 'cancelacion',
        payload: { fecha: ins.fecha, hora_inicio: ins.hora_inicio, inscripcion_id_original: ins.id },
      });

      res.json({ ok: true });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ DELETE /api/clases/inscripcion/:inscripcion_id:', err?.message || err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  /** POST /api/clases/inscribir */
  app.post('/api/clases/inscribir', async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const claseId = Number(req.body?.clase_id);
      const fecha = normalizeFechaYmd(req.body?.fecha);
      const horaInicio = normalizeHoraClase(req.body?.hora_inicio);
      if (!Number.isFinite(claseId) || !fecha || !horaInicio) {
        return res.status(400).json({ error: 'clase_id, fecha (YYYY-MM-DD) y hora_inicio (HH:MM) son requeridos' });
      }

      const { data: clase, error: claseErr } = await supabase
        .from('clases')
        .select(
          'id, sede_id, cancha_id, deporte, titulo, cupo_maximo, duracion_minutos, precio, activo, profesores!inner(id, aprobado, activo)',
        )
        .eq('id', claseId)
        .eq('activo', true)
        .eq('profesores.aprobado', true)
        .eq('profesores.activo', true)
        .maybeSingle();
      if (claseErr) throw claseErr;
      if (!clase) return res.status(404).json({ error: 'Clase no disponible' });

      const horarios = await fetchHorariosClase(claseId);
      if (!horarioMatchesSlot(horarios, fecha, horaInicio)) {
        return res.status(400).json({ error: 'Ese día u horario no está programado para esta clase' });
      }

      const inscriptos = await countInscripcionesSlot(claseId, fecha, horaInicio);
      const cupo = Math.max(1, parseInt(String(clase.cupo_maximo), 10) || 1);
      if (inscriptos >= cupo) {
        return res.status(409).json({ error: 'No hay cupo disponible para este turno' });
      }

      const { data: sedeRow, error: sedeErr } = await supabase
        .from('sedes')
        .select('id, nombre, moneda')
        .eq('id', clase.sede_id)
        .maybeSingle();
      if (sedeErr) throw sedeErr;
      if (!sedeRow) return res.status(404).json({ error: 'Sede no encontrada' });

      const canchaNum = await resolveCanchaNumeroReserva(clase.cancha_id);
      if (canchaNum == null) {
        return res.status(400).json({ error: 'La clase no tiene cancha asignada válida' });
      }

      const sedeNombre = String(sedeRow.nombre || '').trim();
      const duracionMin =
        Number.isFinite(Number(clase.duracion_minutos)) && Number(clase.duracion_minutos) > 0
          ? parseInt(String(clase.duracion_minutos), 10)
          : 60;

      await assertReservaSinSolapeBackend({
        sede: sedeNombre,
        fecha,
        hora: horaInicio,
        cancha: canchaNum,
        duracionMin,
      });

      let nombreJugador = String(user.email || '').split('@')[0] || 'Alumno';
      const { data: perfil } = await supabase
        .from('jugadores_perfil')
        .select('nombre, apellido, apodo, email')
        .eq('email', String(user.email || '').trim().toLowerCase())
        .maybeSingle();
      if (perfil) {
        nombreJugador =
          [perfil.nombre, perfil.apellido].filter(Boolean).join(' ').trim() || perfil.apodo || nombreJugador;
      }

      const precio = Number(clase.precio) || 0;
      const { data: reserva, error: reservaErr } = await supabaseAdmin
        .from('reservas')
        .insert([
          {
            sede: sedeNombre,
            fecha,
            hora: horaInicio,
            cancha: canchaNum,
            nombre: nombreJugador,
            email: String(user.email || '').trim().toLowerCase(),
            telefono: null,
            whatsapp: null,
            nivel: 'Clase',
            precio,
            moneda: String(sedeRow.moneda || 'ARS').trim().toUpperCase() || 'ARS',
            estado: 'confirmada',
            duracion: duracionMin,
            duracion_minutos: duracionMin,
            user_id: user.id,
            tipo: 'clase',
          },
        ])
        .select()
        .single();
      if (reservaErr) throw reservaErr;

      const { data: inscripcion, error: insErr } = await supabaseAdmin
        .from('inscripciones_clases')
        .insert([
          {
            clase_id: claseId,
            user_id: user.id,
            fecha,
            hora_inicio: horaInicio,
            estado: 'pendiente',
            reserva_id: reserva?.id ?? null,
          },
        ])
        .select()
        .single();
      if (insErr) {
        if (reserva?.id != null) {
          await supabaseAdmin.from('reservas').delete().eq('id', reserva.id);
        }
        if (/duplicate|unique/i.test(String(insErr.message || ''))) {
          return res.status(409).json({ error: 'Ya tenés una inscripción para este turno' });
        }
        throw insErr;
      }


      await registrarEventoInternoClase({
        sedeId: clase.sede_id,
        claseId,
        inscripcionId: inscripcion.id,
        userId: user.id,
        tipo: 'inscripcion',
        payload: { fecha, hora_inicio: horaInicio, reserva_id: reserva?.id ?? null },
      });

      res.status(201).json(inscripcion);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ POST /api/clases/inscribir:', err?.message || err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  /** GET /api/profesores?sede_id=&deporte= */
  app.get('/api/profesores', async (req, res) => {
    try {
      const sedeId = Number(req.query.sede_id);
      const deporte = String(req.query.deporte || '').trim().toLowerCase();
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id requerido' });

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .select(`${PROFESOR_PUBLIC_SELECT}, aprobado, activo`)
        .eq('sede_id', sedeId)
        .eq('activo', true)
        .eq('aprobado', true)
        .order('nombre', { ascending: true });
      if (error) throw error;

      const list = (data || [])
        .filter((p) => profesorMatchesDeporte(p, deporte))
        .map((p) => mapProfesorPublic(p));
      res.json(list);
    } catch (err) {
      console.error('❌ GET /api/profesores:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** GET /api/admin/profesores?sede_id= — lista admin (incluye pendientes) */
  app.get('/api/admin/profesores', async (req, res) => {
    try {
      await assertAdminClubOrSuper(req);
      const sedeId = Number(req.query.sede_id);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id requerido' });
      await assertUsuarioPuedeAdministrarSede(req, sedeId);

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .select(
          'id, sede_id, nombre, apellido, foto_url, bio, whatsapp, deportes, especialidad, nivel, certificado_fipa, certificado_numero, certificado_url, certificado_estado, certificado_nota, aprobado, activo, created_at, updated_at',
        )
        .eq('sede_id', sedeId)
        .order('nombre', { ascending: true });
      if (error) throw error;
      res.json(data || []);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/admin/profesores:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** GET /api/admin/profesores-pendientes — super admin */
  app.get('/api/admin/profesores-pendientes', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const { data, error } = await supabaseAdmin
        .from('profesores')
        .select(PROFESOR_ADMIN_DETAIL_SELECT)
        .eq('aprobado', false)
        .eq('activo', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json((data || []).map(mapProfesorAdminRow).filter(Boolean));
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/admin/profesores-pendientes:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** GET /api/admin/profesores-todos — super admin (?estado=pendiente|aprobado|todos, default todos) */
  app.get('/api/admin/profesores-todos', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const estado = String(req.query.estado || 'todos').trim().toLowerCase();
      let q = supabaseAdmin
        .from('profesores')
        .select(PROFESOR_ADMIN_DETAIL_SELECT);
      if (estado === 'pendiente') {
        // Alta club: aprobado=false, activo=true (cola de aprobación super admin)
        q = q.eq('aprobado', false).eq('activo', true);
      } else if (estado === 'aprobado') {
        q = q.eq('aprobado', true).eq('activo', true);
      }
      // estado === 'todos' → sin filtro
      const { data, error } = await q
        .order('nombre', { ascending: true, foreignTable: 'sedes' })
        .order('nombre', { ascending: true });
      if (error) throw error;
      res.json((data || []).map(mapProfesorAdminRow).filter(Boolean));
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/admin/profesores-todos:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** POST /api/admin/profesores/certificado-upload — documento privado, máximo 10 MB. */
  app.post('/api/admin/profesores/certificado-upload', async (req, res) => {
    try {
      await assertAdminClubOrSuper(req);
      const b = req.body || {};
      const sedeId = Number(b.sede_id);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id requerido' });
      await assertUsuarioPuedeAdministrarSede(req, sedeId);
      const mime = String(b.mime_type || '').trim().toLowerCase();
      const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
      if (!allowed.has(mime)) return res.status(400).json({ error: 'Formato de certificado inválido' });
      const base64 = String(b.data_base64 || '').replace(/^data:[^;]+;base64,/, '');
      let buffer;
      try { buffer = Buffer.from(base64, 'base64'); } catch { buffer = null; }
      if (!buffer?.length || buffer.length > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'El certificado debe pesar hasta 10 MB' });
      }
      const extByMime = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const path = `sede-${sedeId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extByMime[mime]}`;
      const { error } = await supabaseAdmin.storage.from('profesor-certificados').upload(path, buffer, {
        contentType: mime,
        upsert: false,
      });
      if (error) throw error;
      res.status(201).json({ path });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ POST certificado profesor:', err?.message || err);
      res.status(500).json({ error: 'No se pudo guardar el certificado' });
    }
  });

  /** GET /api/admin/profesores/:id/certificado-url — URL privada firmada por 2 minutos. */
  app.get('/api/admin/profesores/:id/certificado-url', async (req, res) => {
    try {
      const scope = await assertAdminClubOrSuper(req);
      const profId = Number(req.params.id);
      if (!Number.isFinite(profId)) return res.status(400).json({ error: 'ID inválido' });
      const { data: prof, error: profErr } = await supabaseAdmin
        .from('profesores').select('id, sede_id, certificado_url').eq('id', profId).maybeSingle();
      if (profErr) throw profErr;
      if (!prof) return res.status(404).json({ error: 'Profesor no encontrado' });
      if (!scope.superA) await assertUsuarioPuedeAdministrarSede(req, prof.sede_id);
      const path = String(prof.certificado_url || '').trim();
      if (!path) return res.status(404).json({ error: 'Sin certificado cargado' });
      const { data, error } = await supabaseAdmin.storage.from('profesor-certificados').createSignedUrl(path, 120);
      if (error) throw error;
      res.json({ url: data?.signedUrl || null, expires_in: 120 });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET certificado profesor:', err?.message || err);
      res.status(500).json({ error: 'No se pudo abrir el certificado' });
    }
  });

  /** POST /api/admin/profesores */
  app.post('/api/admin/profesores', async (req, res) => {
    try {
      await assertAdminClubOrSuper(req);
      const b = req.body || {};
      const sedeId = Number(b.sede_id);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id requerido' });
      await assertUsuarioPuedeAdministrarSede(req, sedeId);

      const nombre = String(b.nombre || '').trim();
      if (!nombre) return res.status(400).json({ error: 'nombre requerido' });

      const deportes = Array.isArray(b.deportes)
        ? b.deportes.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
        : [];

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .insert([
          {
            sede_id: sedeId,
            nombre,
            apellido: String(b.apellido || '').trim() || null,
            foto_url: b.foto_url != null ? String(b.foto_url).trim() || null : null,
            bio: b.bio != null ? String(b.bio).trim() || null : null,
            especialidad: b.especialidad != null ? String(b.especialidad).trim() || null : null,
            nivel: b.nivel != null ? String(b.nivel).trim() || null : null,
            whatsapp: b.whatsapp != null ? String(b.whatsapp).trim() || null : null,
            deportes,
            certificado_fipa: Boolean(b.certificado_fipa),
            certificado_numero: b.certificado_numero != null ? String(b.certificado_numero).trim() || null : null,
            certificado_url: b.certificado_url != null ? String(b.certificado_url).trim() || null : null,
            certificado_estado: b.certificado_url ? 'pendiente' : 'sin_documento',
            aprobado: false,
            activo: true,
          },
        ])
        .select()
        .single();
      if (error) throw error;
      res.status(201).json(data);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ POST /api/admin/profesores:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** PATCH /api/admin/profesores/:id/aprobar */
  app.patch('/api/admin/profesores/:id/aprobar', async (req, res) => {
    try {
      const { user } = await assertSuperAdminReq(req);
      const profId = Number(req.params.id);
      if (!Number.isFinite(profId)) return res.status(400).json({ error: 'ID inválido' });

      const { data: existing, error: existingError } = await supabaseAdmin
        .from('profesores')
        .select('id, deportes, certificado_url, certificado_estado')
        .eq('id', profId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) return res.status(404).json({ error: 'Profesor no encontrado' });
      const enseñaPadbol = Array.isArray(existing.deportes) && existing.deportes.includes('padbol');
      if (enseñaPadbol && (!existing.certificado_url || existing.certificado_estado !== 'aprobado')) {
        return res.status(409).json({
          error: 'Para aprobar un instructor de Padbol primero verificá y aprobá su certificado',
        });
      }

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .update({
          activo: true,
          aprobado: true,
          aprobado_por: user.id ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', profId)
        .select()
        .single();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Profesor no encontrado' });
      res.json(data);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ PATCH /api/admin/profesores/:id/aprobar:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** PATCH /api/admin/profesores/:id — actualizar campos (whatsapp, bio, …) */
  app.patch('/api/admin/profesores/:id', async (req, res) => {
    try {
      const scope = await assertAdminClubOrSuper(req);
      const profId = Number(req.params.id);
      if (!Number.isFinite(profId)) return res.status(400).json({ error: 'ID inválido' });

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('profesores')
        .select('id, sede_id, deportes, certificado_fipa, certificado_url, certificado_estado')
        .eq('id', profId)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) return res.status(404).json({ error: 'Profesor no encontrado' });

      if (!scope.superA) {
        await assertUsuarioPuedeAdministrarSede(req, existing.sede_id);
      }

      const b = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (b.sede_id !== undefined) {
        const newSedeId = Number(b.sede_id);
        if (!Number.isFinite(newSedeId)) return res.status(400).json({ error: 'sede_id inválido' });
        if (!scope.superA) await assertUsuarioPuedeAdministrarSede(req, newSedeId);
        patch.sede_id = newSedeId;
      }
      if (b.deportes !== undefined) {
        const deportes = Array.isArray(b.deportes)
          ? b.deportes.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
          : [];
        if (!deportes.length) return res.status(400).json({ error: 'Elegí al menos un deporte' });
        patch.deportes = deportes;
      }
      if (b.certificado_fipa !== undefined) {
        patch.certificado_fipa = Boolean(b.certificado_fipa);
      }
      if (b.certificado_numero !== undefined) {
        patch.certificado_numero = String(b.certificado_numero || '').trim() || null;
      }
      if (b.certificado_url !== undefined) {
        patch.certificado_url = String(b.certificado_url || '').trim() || null;
        if (!scope.superA) patch.certificado_estado = patch.certificado_url ? 'pendiente' : 'sin_documento';
      }
      if (b.especialidad !== undefined) patch.especialidad = String(b.especialidad || '').trim() || null;
      if (b.nivel !== undefined) patch.nivel = String(b.nivel || '').trim() || null;
      if (scope.superA && b.certificado_estado !== undefined) {
        const estado = String(b.certificado_estado || '').trim().toLowerCase();
        if (!['sin_documento', 'pendiente', 'aprobado', 'rechazado'].includes(estado)) {
          return res.status(400).json({ error: 'certificado_estado inválido' });
        }
        patch.certificado_estado = estado;
        patch.certificado_nota = String(b.certificado_nota || '').trim() || null;
        patch.certificado_verificado_at = new Date().toISOString();
        patch.certificado_verificado_por = scope.user?.id || null;
      }
      if (b.whatsapp !== undefined) {
        patch.whatsapp = String(b.whatsapp || '').trim() || null;
      }
      if (b.bio !== undefined) {
        const bio = String(b.bio || '').trim() || null;
        if (bio && bio.length > 500) return res.status(400).json({ error: 'bio máximo 500 caracteres' });
        patch.bio = bio;
      }
      if (b.fecha_nacimiento !== undefined) {
        const fechaNac = b.fecha_nacimiento ? normalizeFechaYmd(b.fecha_nacimiento) : null;
        if (b.fecha_nacimiento && !fechaNac) return res.status(400).json({ error: 'fecha_nacimiento inválida' });
        patch.fecha_nacimiento = fechaNac;
      }
      if (b.genero !== undefined) {
        const genero = b.genero ? normalizeGeneroInstructor(b.genero) : null;
        if (b.genero && !genero) return res.status(400).json({ error: 'genero inválido' });
        patch.genero = genero;
      }

      if (Object.keys(patch).length <= 1) {
        return res.status(400).json({ error: 'Sin campos para actualizar' });
      }

      const depCheck = patch.deportes ?? existing.deportes ?? [];
      const certCheck =
        patch.certificado_fipa !== undefined ? patch.certificado_fipa : Boolean(existing.certificado_fipa);
      if (Array.isArray(depCheck) && depCheck.includes('padbol') && !certCheck) {
        return res.status(400).json({ error: 'Certificado FIPA requerido para enseñar Padbol' });
      }

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .update(patch)
        .eq('id', profId)
        .select(PROFESOR_ADMIN_DETAIL_SELECT)
        .single();
      if (error) throw error;
      res.json(mapProfesorAdminRow(data));
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ PATCH /api/admin/profesores/:id:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** GET /api/instructor/mi-solicitud — fila profesores del usuario (solicitud / instructor) */
  app.get('/api/instructor/mi-solicitud', async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const { data, error } = await supabaseAdmin
        .from('profesores')
        .select(PROFESOR_ADMIN_DETAIL_SELECT)
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Sin solicitud de instructor' });
      res.json(mapProfesorAdminRow(data));
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/instructor/mi-solicitud:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** POST /api/instructor/solicitud — jugador solicita ser instructor FIPA */
  app.post('/api/instructor/solicitud', async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const { data: existing, error: existErr } = await supabaseAdmin
        .from('profesores')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (existErr) throw existErr;
      if (existing) {
        return res.status(409).json({ error: 'Ya tenés una solicitud o ficha de instructor' });
      }

      const b = req.body || {};
      const sedeId = Number(b.sede_id);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id requerido' });

      const nombre = String(b.nombre || '').trim();
      if (!nombre) return res.status(400).json({ error: 'nombre requerido' });

      const genero = normalizeGeneroInstructor(b.genero);
      if (!genero) return res.status(400).json({ error: 'genero inválido' });

      const fechaNac = normalizeFechaYmd(b.fecha_nacimiento);
      if (!fechaNac) return res.status(400).json({ error: 'fecha_nacimiento inválida' });

      const deportes = Array.isArray(b.deportes)
        ? b.deportes.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (!deportes.length) return res.status(400).json({ error: 'Elegí al menos un deporte' });

      const bio = String(b.bio || '').trim();
      if (!bio) return res.status(400).json({ error: 'bio requerida' });
      if (bio.length > 500) return res.status(400).json({ error: 'bio máximo 500 caracteres' });

      const whatsapp = String(b.whatsapp || '').trim();
      if (!whatsapp) return res.status(400).json({ error: 'whatsapp requerido' });

      const certificadoFipa = Boolean(b.certificado_fipa);
      const certificadoNumero = String(b.certificado_numero || '').trim() || null;
      const certificadoUrl = String(b.certificado_url || '').trim() || null;
      if (deportes.includes('padbol') && (!certificadoFipa || !certificadoNumero || !certificadoUrl)) {
        return res.status(400).json({ error: 'Número y documento del certificado requeridos para enseñar Padbol' });
      }

      const fotoUrl = b.foto_url != null ? String(b.foto_url).trim() || null : null;

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .insert([
          {
            user_id: user.id,
            sede_id: sedeId,
            nombre,
            apellido: String(b.apellido || '').trim() || null,
            foto_url: fotoUrl,
            bio,
            deportes,
            especialidad: String(b.especialidad || '').trim() || null,
            nivel: String(b.nivel || '').trim() || null,
            certificado_fipa: certificadoFipa,
            certificado_numero: certificadoNumero,
            certificado_url: certificadoUrl,
            certificado_estado: certificadoUrl ? 'pendiente' : 'sin_documento',
            whatsapp,
            fecha_nacimiento: fechaNac,
            genero,
            aprobado: false,
            activo: true,
          },
        ])
        .select(PROFESOR_ADMIN_DETAIL_SELECT)
        .single();
      if (error) throw error;
      res.status(201).json(mapProfesorAdminRow(data));
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ POST /api/instructor/solicitud:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** GET /api/profesor/mi-perfil — profesor vinculado al usuario autenticado (user_id) */
  app.get('/api/profesor/mi-perfil', async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const { data, error } = await supabaseAdmin
        .from('profesores')
        .select(PROFESOR_ADMIN_DETAIL_SELECT)
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'No tenés ficha de profesor vinculada' });
      const sede = data.sedes;
      const { sedes: _s, ...rest } = data;
      res.json({ ...rest, sede_nombre: sede?.nombre ?? null });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/profesor/mi-perfil:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** PATCH /api/profesor/mi-perfil — el instructor actualiza foto, bio, WhatsApp, fecha y género */
  app.patch('/api/profesor/mi-perfil', async (req, res) => {
    try {
      const user = await requireAuthUser(req);
      const b = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (b.foto_url !== undefined) {
        patch.foto_url = String(b.foto_url || '').trim() || null;
      }
      if (b.whatsapp !== undefined) {
        patch.whatsapp = String(b.whatsapp || '').trim() || null;
      }
      if (b.bio !== undefined) {
        const bio = String(b.bio || '').trim() || null;
        if (bio && bio.length > 500) return res.status(400).json({ error: 'bio máximo 500 caracteres' });
        patch.bio = bio;
      }
      if (b.especialidad !== undefined) patch.especialidad = String(b.especialidad || '').trim() || null;
      if (b.nivel !== undefined) patch.nivel = String(b.nivel || '').trim() || null;
      if (b.certificado_numero !== undefined) {
        patch.certificado_numero = String(b.certificado_numero || '').trim() || null;
        patch.certificado_estado = 'pendiente';
        patch.certificado_nota = null;
        patch.certificado_verificado_at = null;
        patch.certificado_verificado_por = null;
      }
      if (b.certificado_url !== undefined) {
        patch.certificado_url = String(b.certificado_url || '').trim() || null;
        patch.certificado_estado = patch.certificado_url ? 'pendiente' : 'sin_documento';
        patch.certificado_nota = null;
        patch.certificado_verificado_at = null;
        patch.certificado_verificado_por = null;
      }
      if (b.fecha_nacimiento !== undefined) {
        const fechaNac = b.fecha_nacimiento ? normalizeFechaYmd(b.fecha_nacimiento) : null;
        if (b.fecha_nacimiento && !fechaNac) return res.status(400).json({ error: 'fecha_nacimiento inválida' });
        patch.fecha_nacimiento = fechaNac;
      }
      if (b.genero !== undefined) {
        const genero = b.genero ? normalizeGeneroInstructor(b.genero) : null;
        if (b.genero && !genero) return res.status(400).json({ error: 'genero inválido' });
        patch.genero = genero;
      }
      if (Object.keys(patch).length <= 1) {
        return res.status(400).json({ error: 'Sin campos para actualizar' });
      }

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .update(patch)
        .eq('user_id', user.id)
        .select(PROFESOR_ADMIN_DETAIL_SELECT)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'No tenés ficha de profesor vinculada' });
      const sede = data.sedes;
      const { sedes: _s, ...rest } = data;
      res.json({ ...rest, sede_nombre: sede?.nombre ?? null });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ PATCH /api/profesor/mi-perfil:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** PATCH /api/admin/profesores/:id/rechazar — super admin (desactiva solicitud o profesor) */
  app.patch('/api/admin/profesores/:id/rechazar', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const profId = Number(req.params.id);
      if (!Number.isFinite(profId)) return res.status(400).json({ error: 'ID inválido' });

      const { data, error } = await supabaseAdmin
        .from('profesores')
        .update({ activo: false })
        .eq('id', profId)
        .select()
        .single();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Profesor no encontrado' });
      res.json(data);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ PATCH /api/admin/profesores/:id/rechazar:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** GET /api/admin/clases?sede_id= */
  app.get('/api/admin/clases', async (req, res) => {
    try {
      await assertAdminClubOrSuper(req);
      const sedeId = Number(req.query.sede_id);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'sede_id requerido' });
      await assertUsuarioPuedeAdministrarSede(req, sedeId);

      const { data, error } = await supabase
        .from('clases')
        .select(
          'id, sede_id, profesor_id, cancha_id, deporte, titulo, descripcion, tipo, cupo_maximo, duracion_minutos, precio, activo, created_at, profesores(id, nombre, apellido, aprobado)',
        )
        .eq('sede_id', sedeId)
        .order('titulo', { ascending: true });
      if (error) throw error;

      const out = await Promise.all(
        (data || []).map(async (c) => {
          const horarios = await fetchHorariosClase(c.id);
          const prof = c.profesores;
          const nombreProf =
            [String(prof?.nombre || '').trim(), String(prof?.apellido || '').trim()].filter(Boolean).join(' ').trim() ||
            prof?.nombre ||
            '—';
          const { profesores, ...rest } = c;
          return { ...rest, profesor_nombre: nombreProf, horarios };
        }),
      );
      res.json(out);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/admin/clases:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** GET /api/admin/clases/:id/asistencia?fecha=YYYY-MM-DD */
  app.get('/api/admin/clases/:id/asistencia', async (req, res) => {
    try {
      await assertAdminClubOrSuper(req);
      const claseId = Number(req.params.id);
      const fecha = normalizeFechaYmd(req.query.fecha);
      if (!Number.isFinite(claseId)) return res.status(400).json({ error: 'ID inválido' });
      if (!fecha) return res.status(400).json({ error: 'fecha (YYYY-MM-DD) requerida' });

      const { data: clase, error: claseErr } = await supabase
        .from('clases')
        .select('id, sede_id, titulo')
        .eq('id', claseId)
        .maybeSingle();
      if (claseErr) throw claseErr;
      if (!clase) return res.status(404).json({ error: 'Clase no encontrada' });
      await assertUsuarioPuedeAdministrarSede(req, clase.sede_id);

      const { data: insRows, error: insErr } = await supabaseAdmin
        .from('inscripciones_clases')
        .select(
          'id, clase_id, user_id, fecha, hora_inicio, estado, asistio, asistencia_marcada_at, asistencia_marcada_por, created_at',
        )
        .eq('clase_id', claseId)
        .eq('fecha', fecha)
        .order('hora_inicio', { ascending: true });
      if (insErr) throw insErr;

      const activas = (insRows || []).filter((r) => {
        const est = String(r.estado || '').toLowerCase();
        return ESTADOS_INSCRIPCION_CUENTAN_CUPO.has(est) || est === 'pagada';
      });
      const contactMap = await perfilContactoPorUserIds(activas.map((r) => r.user_id));

      const inscripciones = activas.map((r) => {
        const uid = String(r.user_id || '');
        const c = contactMap.get(uid) || {};
        return {
          id: r.id,
          user_id: r.user_id,
          fecha: r.fecha,
          hora_inicio: normalizeHoraClase(r.hora_inicio) || r.hora_inicio,
          estado: r.estado,
          nombre: c.nombre || '—',
          email: c.email,
          telefono: c.telefono,
          asistio: r.asistio,
          asistencia_marcada_at: r.asistencia_marcada_at,
          asistencia_marcada_por: r.asistencia_marcada_por,
        };
      });

      res.json({
        clase_id: claseId,
        clase_titulo: clase.titulo,
        fecha,
        inscripciones,
      });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ GET /api/admin/clases/:id/asistencia:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** PATCH /api/admin/clases/:id/asistencia/:inscripcion_id */
  app.patch('/api/admin/clases/:id/asistencia/:inscripcion_id', async (req, res) => {
    try {
      const scope = await assertAdminClubOrSuper(req);
      const claseId = Number(req.params.id);
      const insId = Number(req.params.inscripcion_id);
      if (!Number.isFinite(claseId) || !Number.isFinite(insId)) {
        return res.status(400).json({ error: 'ID inválido' });
      }
      if (typeof req.body?.asistio !== 'boolean') {
        return res.status(400).json({ error: 'asistio (boolean) requerido' });
      }

      const { data: clase, error: claseErr } = await supabase
        .from('clases')
        .select('id, sede_id')
        .eq('id', claseId)
        .maybeSingle();
      if (claseErr) throw claseErr;
      if (!clase) return res.status(404).json({ error: 'Clase no encontrada' });
      await assertUsuarioPuedeAdministrarSede(req, clase.sede_id);

      const { data: ins, error: insErr } = await supabaseAdmin
        .from('inscripciones_clases')
        .select('id, clase_id')
        .eq('id', insId)
        .eq('clase_id', claseId)
        .maybeSingle();
      if (insErr) throw insErr;
      if (!ins) return res.status(404).json({ error: 'Inscripción no encontrada' });

      const marcadoPor = String(scope.email || '').trim().toLowerCase() || 'admin';
      const { data, error } = await supabaseAdmin
        .from('inscripciones_clases')
        .update({
          asistio: req.body.asistio,
          asistencia_marcada_at: new Date().toISOString(),
          asistencia_marcada_por: marcadoPor,
        })
        .eq('id', insId)
        .select('id, asistio, asistencia_marcada_at, asistencia_marcada_por')
        .single();
      if (error) throw error;
      await registrarEventoInternoClase({
        sedeId: clase.sede_id,
        claseId,
        inscripcionId: insId,
        userId: null,
        tipo: 'asistencia',
        payload: { asistio: req.body.asistio, marcado_por: marcadoPor },
      });
      res.json(data);
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ PATCH /api/admin/clases/:id/asistencia/:inscripcion_id:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** PATCH /api/admin/clases/:id — edición completa de clase y horarios */
  app.patch('/api/admin/clases/:id', async (req, res) => {
    try {
      await assertAdminClubOrSuper(req);
      const claseId = Number(req.params.id);
      if (!Number.isFinite(claseId)) return res.status(400).json({ error: 'ID inválido' });

      const { data: existing, error: exErr } = await supabase
        .from('clases')
        .select('id, sede_id, profesor_id, cancha_id, deporte')
        .eq('id', claseId)
        .maybeSingle();
      if (exErr) throw exErr;
      if (!existing) return res.status(404).json({ error: 'Clase no encontrada' });
      await assertUsuarioPuedeAdministrarSede(req, existing.sede_id);

      const b = req.body || {};
      const patch = {};
      if (typeof req.body?.activo === 'boolean') patch.activo = req.body.activo;
      if (b.titulo !== undefined) {
        const titulo = String(b.titulo || '').trim();
        if (!titulo) return res.status(400).json({ error: 'titulo requerido' });
        patch.titulo = titulo;
      }
      if (b.descripcion !== undefined) patch.descripcion = String(b.descripcion || '').trim() || null;
      if (b.tipo !== undefined) {
        const tipo = String(b.tipo || '').trim().toLowerCase();
        if (!['individual', 'grupal'].includes(tipo)) return res.status(400).json({ error: 'tipo inválido' });
        patch.tipo = tipo;
      }
      if (b.cupo_maximo !== undefined) patch.cupo_maximo = Math.max(1, parseInt(String(b.cupo_maximo), 10) || 1);
      if (b.duracion_minutos !== undefined) patch.duracion_minutos = Math.max(15, parseInt(String(b.duracion_minutos), 10) || 60);
      if (b.precio !== undefined) patch.precio = Math.max(0, Number(b.precio) || 0);
      if (b.horas_cancelacion !== undefined) patch.horas_cancelacion = Math.max(0, parseInt(String(b.horas_cancelacion), 10) || 24);
      if (b.deporte !== undefined) patch.deporte = String(b.deporte || '').trim().toLowerCase();
      if (b.profesor_id !== undefined) patch.profesor_id = Number(b.profesor_id);
      if (b.cancha_id !== undefined) patch.cancha_id = Number(b.cancha_id);

      const profesorId = patch.profesor_id ?? existing.profesor_id;
      const canchaId = patch.cancha_id ?? existing.cancha_id;
      const deporte = patch.deporte ?? existing.deporte;
      if (!Number.isFinite(Number(profesorId)) || !Number.isFinite(Number(canchaId)) || !deporte) {
        return res.status(400).json({ error: 'profesor, cancha y deporte válidos son requeridos' });
      }
      const { data: prof, error: profErr } = await supabaseAdmin
        .from('profesores')
        .select('id, sede_id, aprobado, activo, deportes, certificado_estado')
        .eq('id', profesorId)
        .maybeSingle();
      if (profErr) throw profErr;
      if (!prof || Number(prof.sede_id) !== Number(existing.sede_id) || !prof.aprobado || prof.activo === false) {
        return res.status(409).json({ error: 'Instructor inválido, inactivo o sin aprobar' });
      }
      if (!Array.isArray(prof.deportes) || !prof.deportes.includes(deporte)) {
        return res.status(400).json({ error: 'El instructor no está habilitado para ese deporte' });
      }
      if (deporte === 'padbol' && prof.certificado_estado !== 'aprobado') {
        return res.status(409).json({ error: 'El certificado del instructor debe estar aprobado' });
      }
      const { data: cancha, error: canchaErr } = await supabaseAdmin
        .from('canchas').select('id, sede_id').eq('id', canchaId).maybeSingle();
      if (canchaErr) throw canchaErr;
      if (!cancha || Number(cancha.sede_id) !== Number(existing.sede_id)) {
        return res.status(400).json({ error: 'La cancha no pertenece a la sede' });
      }

      const horarios = b.horarios;
      let horariosRows = null;
      if (horarios !== undefined) {
        if (!Array.isArray(horarios) || !horarios.length) return res.status(400).json({ error: 'Se requiere al menos un horario' });
        horariosRows = horarios.map((h) => {
          const dia = Number(h.dia_semana);
          const hi = normalizeHoraClase(h.hora_inicio);
          const hf = normalizeHoraClase(h.hora_fin);
          if (!Number.isFinite(dia) || dia < 0 || dia > 6 || !hi || !hf || hi >= hf) {
            throw Object.assign(new Error('Horario inválido'), { status: 400 });
          }
          return { clase_id: claseId, dia_semana: dia, hora_inicio: hi, hora_fin: hf };
        });
      }

      if (!Object.keys(patch).length && !horariosRows) return res.status(400).json({ error: 'Nada que actualizar' });
      patch.updated_at = new Date().toISOString();

      const { data, error } = await supabaseAdmin
        .from('clases')
        .update(patch)
        .eq('id', claseId)
        .select()
        .single();
      if (error) throw error;
      if (horariosRows) {
        const { error: deleteError } = await supabaseAdmin.from('clases_horarios').delete().eq('clase_id', claseId);
        if (deleteError) throw deleteError;
        const { error: insertError } = await supabaseAdmin.from('clases_horarios').insert(horariosRows);
        if (insertError) throw insertError;
      }
      res.json({ ...data, horarios: await fetchHorariosClase(claseId) });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ PATCH /api/admin/clases/:id:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });

  /** POST /api/admin/clases */
  app.post('/api/admin/clases', async (req, res) => {
    try {
      await assertAdminClubOrSuper(req);
      const b = req.body || {};
      const sedeId = Number(b.sede_id);
      const profesorId = Number(b.profesor_id);
      const canchaId = b.cancha_id != null && b.cancha_id !== '' ? Number(b.cancha_id) : null;
      const titulo = String(b.titulo || '').trim();
      const deporte = String(b.deporte || '').trim().toLowerCase();
      const horarios = Array.isArray(b.horarios) ? b.horarios : [];

      if (!Number.isFinite(sedeId) || !Number.isFinite(profesorId) || !Number.isFinite(canchaId) || !titulo || !deporte) {
        return res.status(400).json({ error: 'sede_id, profesor_id, cancha_id, deporte y titulo son requeridos' });
      }
      if (!horarios.length) return res.status(400).json({ error: 'horarios requerido (al menos un turno)' });

      await assertUsuarioPuedeAdministrarSede(req, sedeId);

      const { data: prof, error: profErr } = await supabase
        .from('profesores')
        .select('id, sede_id, aprobado, activo, deportes, certificado_estado')
        .eq('id', profesorId)
        .maybeSingle();
      if (profErr) throw profErr;
      if (!prof || Number(prof.sede_id) !== sedeId) {
        return res.status(400).json({ error: 'profesor_id no pertenece a la sede' });
      }
      if (!prof.aprobado || prof.activo === false) {
        return res.status(409).json({ error: 'El instructor debe estar aprobado y activo' });
      }
      if (!Array.isArray(prof.deportes) || !prof.deportes.includes(deporte)) {
        return res.status(400).json({ error: 'El instructor no está habilitado para ese deporte' });
      }
      if (deporte === 'padbol' && prof.certificado_estado !== 'aprobado') {
        return res.status(409).json({ error: 'El certificado del instructor debe estar aprobado' });
      }

      if (Number.isFinite(canchaId)) {
        const { data: cancha, error: canchaErr } = await supabase
          .from('canchas')
          .select('id, sede_id')
          .eq('id', canchaId)
          .maybeSingle();
        if (canchaErr) throw canchaErr;
        if (!cancha || Number(cancha.sede_id) !== sedeId) {
          return res.status(400).json({ error: 'cancha_id no pertenece a la sede' });
        }
      }

      const cupo = parseInt(String(b.cupo_maximo), 10);
      const duracion = parseInt(String(b.duracion_minutos), 10);
      const precio = b.precio != null && b.precio !== '' ? Number(b.precio) : 0;

      const { data: clase, error: claseErr } = await supabaseAdmin
        .from('clases')
        .insert([
          {
            sede_id: sedeId,
            profesor_id: profesorId,
            cancha_id: canchaId,
            deporte,
            titulo,
            descripcion: b.descripcion != null ? String(b.descripcion).trim() || null : null,
            tipo: String(b.tipo || 'grupal').trim() || 'grupal',
            cupo_maximo: Number.isFinite(cupo) && cupo > 0 ? cupo : 4,
            duracion_minutos: Number.isFinite(duracion) && duracion > 0 ? duracion : 60,
            precio: Number.isFinite(precio) && precio >= 0 ? precio : 0,
            activo: typeof b.activo === 'boolean' ? b.activo : true,
            horas_cancelacion:
              b.horas_cancelacion != null && b.horas_cancelacion !== ''
                ? Math.max(0, parseInt(String(b.horas_cancelacion), 10) || 24)
                : 24,
          },
        ])
        .select()
        .single();
      if (claseErr) throw claseErr;

      const horariosRows = [];
      for (const h of horarios) {
        const dia = Number(h.dia_semana);
        const hi = normalizeHoraClase(h.hora_inicio);
        const hf = normalizeHoraClase(h.hora_fin);
        if (!Number.isFinite(dia) || dia < 0 || dia > 6 || !hi || !hf) {
          await supabaseAdmin.from('clases').delete().eq('id', clase.id);
          return res.status(400).json({ error: 'Cada horario requiere dia_semana (0-6), hora_inicio y hora_fin' });
        }
        horariosRows.push({
          clase_id: clase.id,
          dia_semana: dia,
          hora_inicio: hi,
          hora_fin: hf,
        });
      }

      const { data: horariosIns, error: horErr } = await supabaseAdmin
        .from('clases_horarios')
        .insert(horariosRows)
        .select();
      if (horErr) {
        await supabaseAdmin.from('clases').delete().eq('id', clase.id);
        throw horErr;
      }

      res.status(201).json({ ...clase, horarios: horariosIns || [] });
    } catch (err) {
      const st = err.status || 500;
      if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
      console.error('❌ POST /api/admin/clases:', err?.message || err);
      res.status(500).json({ error: 'No se pudo completar la operación de clases. Intenta nuevamente.' });
    }
  });
}
