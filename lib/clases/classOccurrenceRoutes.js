import crypto from 'node:crypto';

function id(value) {
  const s = String(value ?? '');
  return /^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
}
function slot(body) {
  const fecha = String(body?.fecha ?? '');
  const hora = String(body?.hora_inicio ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)
    || !Number.isFinite(Date.parse(fecha + 'T12:00:00Z'))
    || new Date(fecha + 'T12:00:00Z').toISOString().slice(0, 10) !== fecha) {
    throw Object.assign(new Error('Fecha u horario inválido'), { status: 400 });
  }
  return { p_fecha: fecha, p_hora: hora };
}
const commandMessages = {
  "CLASE_ORGANIZADOR_CONTACTO_REQUERIDO": "El organizador necesita nombre y WhatsApp válidos en su perfil.",
  "CLASE_OCURRENCIA_NO_PREPARADA": "Este turno todavía no fue preparado por la sede.",
  "CLASE_OCURRENCIA_NO_DISPONIBLE": "Este turno ya no está disponible.",
  "CLASE_OCURRENCIA_COMPLETA": "No hay cupo disponible para este turno.",
  "CLASE_INSCRIPCION_DUPLICADA": "Ya tenés una inscripción para este turno.",
  "CLASE_INSCRIPCION_AJENA": "No podés modificar la inscripción de otra persona.",
  "CLASE_OTRO_ORGANIZADOR": "Sólo el organizador o un administrador general puede cancelar este turno.",
  "CLASE_INSCRIPCION_NO_ACTIVA": "Esta inscripción ya no está activa.",
  "CLASE_CANCELACION_FUERA_PLAZO": "Ya pasó el plazo para cancelar esta inscripción.",
  "CLASE_TOKEN_INVALIDO": "El QR no corresponde a esta inscripción.",
  "CLASE_CHECKIN_FECHA_INVALIDA": "La asistencia sólo se registra el día de la clase.",
  "CLASE_CHECKIN_YA_REALIZADO": "La asistencia de este alumno ya fue registrada.",
  "CLASE_CANCHA_INVALIDA": "La sede debe asignar una cancha válida a esta clase.",
  "CLASE_DURACION_INVALIDA": "La sede debe configurar una duración válida para esta clase.",
  "CLASE_PRECIO_REVISAR": "La sede debe revisar el precio configurado para esta clase.",
  "CLASE_TIMEZONE_REVISAR": "La sede debe revisar su zona horaria.",
  "CLASE_INACTIVA": "Esta clase no está disponible.",
  "CLASE_HORARIO_INVALIDO": "Ese día u horario no está programado para esta clase.",
  "CLASE_SEDE_NO_RESERVABLE": "Esta sede no admite reservas de clases."
};

function commandError(error) {
  const message = String(error?.message || '');
  if (error?.code === '23P01') return Object.assign(new Error('El horario se solapa con otra reserva'), { status: 409 });
  if (error?.code === '23505') return Object.assign(new Error('CLASE_INSCRIPCION_DUPLICADA'), { status: 409 });
  if (/^CLASE_[A-Z_]+$/.test(message)) {
    const status = /AJENA|OTRO_ORGANIZADOR|NO_AUTORIZADO/.test(message) ? 403
      : /NO_ENCONTRADA|NO_ENCONTRADO/.test(message) ? 404
        : /HORARIO_INVALIDO|TOKEN_INVALIDO|COMANDO_INVALIDO/.test(message) ? 400 : 409;
    return Object.assign(new Error(commandMessages[message] || 'No se pudo completar la operación de clase.'), { status, code: message });
  }
  return Object.assign(new Error('Clases temporalmente no disponibles'), { status: 503 });
}

export function mountClassOccurrenceRoutes(app, deps) {
  const { supabaseAdmin: db, requireAuthUser, assertAdminClubOrSuper, assertUsuarioPuedeAdministrarSede } = deps;
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      const status = error.status || 503;
      res.status(status).json({ error: status === 503 ? 'Clases temporalmente no disponibles' : error.message, ...(error.code ? { code: error.code } : {}) });
    }
  };
  async function staff(req, claseId) {
    const user = await requireAuthUser(req);
    const scope = await assertAdminClubOrSuper(req);
    const { data: clase, error } = await db.from('clases').select('id,sede_id,cancha_id,duracion_minutos').eq('id', claseId).maybeSingle();
    if (error) throw commandError(error);
    if (!clase) throw Object.assign(new Error('Clase no encontrada'), { status: 404 });
    await assertUsuarioPuedeAdministrarSede(req, clase.sede_id);
    return { user, scope, clase };
  }
  async function command(action, user, args) {
    const { data, error } = await db.rpc('clases_ocurrencia_comando', {
      p_accion: action, p_user_id: user.id, p_email: user.email || null, ...args,
    });
    if (error) throw commandError(error);
    if (!data || typeof data !== 'object') throw commandError(null);
    return data;
  }
  async function enrollment(req) {
    const insId = id(req.params.inscripcion_id);
    if (!insId) throw Object.assign(new Error('ID inválido'), { status: 400 });
    const { data, error } = await db.from('inscripciones_clases').select('id,clase_id').eq('id', insId).maybeSingle();
    if (error) throw commandError(error);
    if (!data) throw Object.assign(new Error('Inscripción no encontrada'), { status: 404 });
    return { p_inscripcion_id: insId, p_clase_id: data.clase_id };
  }
  const classId = (raw) => {
    const value = id(raw);
    if (!value) throw Object.assign(new Error('ID inválido'), { status: 400 });
    return value;
  };
  app.get('/api/clases/:id/capacidades', wrap(async (req, res) => {
    await requireAuthUser(req);
    const claseId = classId(req.params.id);
    let result;
    try { result = await staff(req, claseId); } catch (error) {
      if (error.status === 403) return res.json({ clase_id: claseId, can_manage: false,
        ...(req.query.fecha !== undefined || req.query.hora_inicio !== undefined ? { ocurrencia: null } : {}) });
      throw error;
    }
    const { data: horarios, error } = await db.from('clases_horarios')
      .select('dia_semana,hora_inicio,hora_fin').eq('clase_id', claseId);
    if (error) throw commandError(error);
    let ocurrencia;
    if (req.query.fecha !== undefined || req.query.hora_inicio !== undefined) {
      const querySlot = slot(req.query);
      const { data: occurrence, error: occurrenceError } = await db.from('clases_ocurrencias')
        .select('id,estado,organizador_id').eq('clase_id', claseId)
        .eq('fecha', querySlot.p_fecha).eq('hora_inicio', querySlot.p_hora)
        .order('id', { ascending: false }).limit(1).maybeSingle();
      if (occurrenceError) throw commandError(occurrenceError);
      ocurrencia = occurrence ? { id: occurrence.id, estado: occurrence.estado,
        can_cancel: occurrence.estado === 'preparada'
          && (String(occurrence.organizador_id) === String(result.user.id) || Boolean(result.scope.superA)) } : null;
    }
    res.json({ clase_id: claseId, can_manage: true, cancha_id: result.clase.cancha_id, duracion_minutos: result.clase.duracion_minutos, horarios: horarios || [], ...(ocurrencia !== undefined ? { ocurrencia } : {}) });
  }));
  app.post('/api/admin/clases/:id/ocurrencias', wrap(async (req, res) => {
    const claseId = classId(req.params.id);
    const { user, scope } = await staff(req, claseId);
    const data = await command('preparar', user, { p_clase_id: claseId, ...slot(req.body), p_super: Boolean(scope.superA) });
    res.status(data.reutilizada ? 200 : 201).json(data);
  }));
  app.post('/api/clases/inscribir', wrap(async (req, res) => {
    const user = await requireAuthUser(req);
    const data = await command('inscribir', user, { p_clase_id: classId(req.body?.clase_id), ...slot(req.body) });
    res.status(201).json(data);
  }));
  app.delete('/api/clases/inscripcion/:inscripcion_id', wrap(async (req, res) => {
    const user = await requireAuthUser(req);
    res.json(await command('retirar', user, await enrollment(req)));
  }));
  app.post('/api/clases/inscripcion/:inscripcion_id/acceso', wrap(async (req, res) => {
    const user = await requireAuthUser(req);
    res.json(await command('acceso', user, { ...await enrollment(req), p_token: crypto.randomBytes(32).toString('hex') }));
  }));
  app.post('/api/admin/clases/:id/checkin', wrap(async (req, res) => {
    const claseId = classId(req.params.id);
    const { user } = await staff(req, claseId);
    const token = String(req.body?.qr_code || '');
    if (!/^[0-9a-f]{64}$/.test(token)) throw Object.assign(new Error('QR de clase inválido'), { status: 400 });
    res.json(await command('checkin', user, { p_clase_id: claseId, p_inscripcion_id: classId(req.body?.inscripcion_id), p_token: token }));
  }));
  app.delete('/api/admin/clases/:id/ocurrencias/:ocurrencia_id', wrap(async (req, res) => {
    const claseId = classId(req.params.id);
    const { user, scope } = await staff(req, claseId);
    res.json(await command('cancelar_ocurrencia', user, { p_clase_id: claseId, p_ocurrencia_id: classId(req.params.ocurrencia_id), p_super: Boolean(scope.superA) }));
  }));
}
