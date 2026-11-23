import express from 'express';
import {
  CODIGO_HORARIOS_UNAVAILABLE,
  CODIGO_SEDE_TIMEZONE_INVALIDA,
  ClasesHorariosError,
  cargarHorariosPorClase,
  detectarEsquemaHorarios,
  motivoZonaInvalida,
  zonaValida,
} from '../lib/clases/horarios.js';

function formatHora(value) {
  if (!value) return null;
  return String(value).slice(0, 5);
}

function parseClaseId(id) {
  const raw = String(id);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const claseId = Number(raw);
  if (!Number.isSafeInteger(claseId)) return null;
  return claseId;
}

function normalizeCertificaciones(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function mapClaseRow(clase, {
  reservasCount = 0,
  fecha = null,
  hora = null,
  horarioId = null,
  diaSemana = null,
  horaInicio = null,
  horaFin = null,
  recurrente = false,
} = {}) {
  const profesor = clase.profesores ?? null;
  const sede = clase.sedes ?? null;
  const cupoMax = clase.cupo_maximo ?? 4;
  const spotsDisponibles = Math.max(cupoMax - reservasCount, 0);
  // La zona sale de la sede (contrato existente). Si falta o es inválida,
  // zona_horaria queda null: no se asume Argentina en silencio.
  // Nunca se usa una zona enviada por el cliente.
  const zonaHoraria = zonaValida(sede?.timezone);

  return {
    id: clase.id,
    horario_id: horarioId,
    titulo: clase.titulo ?? null,
    descripcion: clase.descripcion ?? '',
    deporte: clase.deporte,
    tipo: clase.tipo ?? null,
    nivel: clase.tipo ?? null,
    sede_id: clase.sede_id,
    cancha_id: clase.cancha_id ?? null,
    sede_nombre: sede?.nombre ?? null,
    fecha: fecha ?? null,
    hora: formatHora(hora),
    // Turno recurrente (dia_semana/hora_inicio/hora_fin del DDL efectivo).
    // `fecha`/`hora` son la próxima ocurrencia en el calendario local de la
    // sede; sin horario resoluble quedan en null (no se fabrican).
    dia_semana: diaSemana,
    hora_inicio: formatHora(horaInicio),
    hora_fin: formatHora(horaFin),
    recurrente: Boolean(recurrente),
    zona_horaria: zonaHoraria,
    duracion_minutos: clase.duracion_minutos ?? 60,
    precio: clase.precio,
    moneda: sede?.moneda ?? 'ARS',
    cupo_max: cupoMax,
    cupo_maximo: cupoMax,
    horas_cancelacion: clase.horas_cancelacion ?? null,
    activo: clase.activo ?? true,
    reservas_count: reservasCount,
    spots_disponibles: spotsDisponibles,
    profesor_id: clase.profesor_id,
    profesor_nombre: profesor?.nombre ?? 'Profesor',
    profesor_foto_url: profesor?.foto_url ?? null,
    profesor_bio: profesor?.bio ?? '',
    profesor_certificaciones: normalizeCertificaciones(profesor?.certificaciones),
    // Estado del profesor: el listado nativo exige estos campos para habilitar
    // la reserva (ver src/lib/reservaModalidadPure.cjs en la app). Se exponen
    // tal como están persistidos; no se infieren aprobaciones.
    profesor_activo: profesor?.activo ?? null,
    profesor_aprobado: profesor?.aprobado ?? null,
    profesor_certificacion_estado: profesor?.certificado_estado ?? null,
  };
}

function expandClasesWithHorarios(clases, horariosByClaseId) {
  const expanded = [];

  clases.forEach((clase) => {
    const reservasCount = clase.clases_reservas?.length ?? 0;
    const horarios = horariosByClaseId[String(clase.id)] ?? [];

    // Sin horario resoluble no se publica una ocurrencia inventada desde
    // clases.created_at: legacy/ausencia de tabla no debe dar falso éxito.
    if (horarios.length === 0) return;

    horarios.forEach((horario) => {
      expanded.push(mapClaseRow(clase, {
        reservasCount,
        fecha: horario.fecha,
        hora: horario.hora,
        horarioId: horario.horario_id,
        diaSemana: horario.dia_semana,
        horaInicio: horario.hora_inicio,
        horaFin: horario.hora_fin,
        recurrente: horario.recurrente,
      }));
    });
  });

  return expanded;
}

function sedesConZonaInvalida(clases) {
  const porSede = new Map();
  for (const clase of clases) {
    const cruda = clase?.sedes?.timezone ?? null;
    if (zonaValida(cruda)) continue;
    const sedeId = clase?.sede_id ?? null;
    const key = `${sedeId}::${cruda ?? ''}`;
    if (!porSede.has(key)) {
      porSede.set(key, {
        sede_id: sedeId,
        timezone: cruda,
        motivo: motivoZonaInvalida(cruda),
      });
    }
  }
  return [...porSede.values()];
}

const CLASE_SELECT = `
  id,
  sede_id,
  profesor_id,
  cancha_id,
  deporte,
  titulo,
  descripcion,
  tipo,
  cupo_maximo,
  duracion_minutos,
  precio,
  activo,
  created_at,
  horas_cancelacion,
  profesores ( id, nombre, bio, foto_url, certificaciones, aprobado, activo, certificado_estado ),
  sedes ( id, nombre, moneda, timezone ),
  clases_reservas ( id )
`;

export function createClasesRouter({ supabaseAdmin, getAuthenticatedUser, now = () => new Date() }) {
  const router = express.Router();

  // Detección del esquema de horarios por instancia de router: se cachea el
  // resultado (tabla + forma recurrente/legacy), no una tabla asumida. Así el
  // router consulta dia_semana/hora_inicio/hora_fin cuando el DDL es recurrente
  // y sólo usa fecha/hora cuando la tabla realmente tiene esa forma.
  let esquemaHorariosPromise = null;
  function esquemaHorarios() {
    if (!esquemaHorariosPromise) {
      esquemaHorariosPromise = detectarEsquemaHorarios(supabaseAdmin).catch((error) => {
        // Un fallo transitorio no debe quedar cacheado: el próximo request
        // vuelve a detectar y puede recuperarse.
        esquemaHorariosPromise = null;
        throw error;
      });
    }
    return esquemaHorariosPromise;
  }

  // GET /api/clases/disponibles — active classes with available spots
  router.get('/disponibles', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const ahora = now();

      const { data: clases, error } = await supabaseAdmin
        .from('clases')
        .select(CLASE_SELECT)
        .eq('activo', true)
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Configuración de sede incompleta: no se publica ninguna ocurrencia
      // calculada con una zona asumida. Se pide revisión explícita.
      const sedesInvalidas = sedesConZonaInvalida(clases || []);
      if (sedesInvalidas.length > 0) {
        throw new ClasesHorariosError(
          CODIGO_SEDE_TIMEZONE_INVALIDA,
          'La zona horaria de una o más sedes requiere revisión',
          { sedes_afectadas: sedesInvalidas },
        );
      }

      const esquema = await esquemaHorarios();
      const claseIds = (clases || []).map((clase) => clase.id);
      const zonaPorClaseId = Object.fromEntries(
        (clases || []).map((clase) => [String(clase.id), clase.sedes?.timezone ?? null]),
      );
      const horariosByClaseId = await cargarHorariosPorClase(
        supabaseAdmin,
        esquema,
        claseIds,
        { ahora, zonaPorClaseId },
      );

      const result = expandClasesWithHorarios(clases || [], horariosByClaseId)
        .filter((clase) => clase.spots_disponibles > 0);

      res.json(result);
    } catch (err) {
      if (err?.code === CODIGO_SEDE_TIMEZONE_INVALIDA) {
        return res.status(409).json({
          error: 'La zona horaria de una o más sedes requiere revisión (sedes.timezone). '
            + 'No se publican horarios calculados con una zona asumida.',
          code: CODIGO_SEDE_TIMEZONE_INVALIDA,
          revision_requerida: true,
          sedes_afectadas: err.sedes_afectadas ?? [],
        });
      }
      if (err?.code === CODIGO_HORARIOS_UNAVAILABLE) {
        // Fallo técnico de detección/lectura: no es un vacío válido. Se
        // invalida el cache de esquema y se responde 503 con reintento.
        esquemaHorariosPromise = null;
        console.warn('⚠️ Horarios de clases no disponibles:', err.message);
        return res.status(503).json({
          error: 'No se pudieron cargar los horarios de clases. Reintentá en unos segundos.',
          code: CODIGO_HORARIOS_UNAVAILABLE,
          retry: true,
        });
      }
      console.error('❌ Error GET /api/clases/disponibles:', err.message);
      res.status(500).json({ error: 'No se pudo cargar el listado de clases.' });
    }
  });

  // POST /api/clases/:id/reservar — reserve a spot in a class
  router.post('/:id/reservar', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const claseId = parseClaseId(req.params.id);
      if (claseId == null) {
        return res.status(400).json({ error: 'ID de clase inválido' });
      }

      const { data: clase, error: fetchErr } = await supabaseAdmin
        .from('clases')
        .select(`
          id,
          sede_id,
          profesor_id,
          cancha_id,
          deporte,
          titulo,
          descripcion,
          tipo,
          cupo_maximo,
          duracion_minutos,
          precio,
          activo,
          created_at,
          horas_cancelacion,
          profesores ( id, nombre, bio, foto_url, certificaciones, aprobado, activo, certificado_estado ),
          sedes ( id, nombre, moneda, timezone )
        `)
        .eq('id', claseId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!clase) {
        return res.status(404).json({ error: 'Clase no encontrada' });
      }
      if (!clase.activo) {
        return res.status(400).json({ error: 'Esta clase ya no acepta reservas' });
      }

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from('clases_reservas')
        .select('id')
        .eq('clase_id', claseId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingErr) throw existingErr;
      if (existing) {
        return res.status(409).json({ error: 'Ya reservaste esta clase' });
      }

      const { count, error: countErr } = await supabaseAdmin
        .from('clases_reservas')
        .select('*', { count: 'exact', head: true })
        .eq('clase_id', claseId);

      if (countErr) throw countErr;

      const cupoMax = clase.cupo_maximo ?? 4;
      if ((count ?? 0) >= cupoMax) {
        return res.status(409).json({ error: 'La clase ya está completa' });
      }

      const { data: reserva, error: insertErr } = await supabaseAdmin
        .from('clases_reservas')
        .insert([{
          clase_id: claseId,
          user_id: user.id,
          email: user.email ?? null,
        }])
        .select('id')
        .single();

      if (insertErr) {
        // El trigger candidato local resuelve la carrera count/insert. Se
        // conserva el contrato HTTP útil también si otro proceso insertó
        // primero o si el usuario duplicó su propia reserva.
        const msg = String(insertErr.message ?? '');
        if (insertErr.code === 'P0001' && msg.includes('CLASE_COMPLETA')) {
          return res.status(409).json({ error: 'La clase ya está completa' });
        }
        if (insertErr.code === 'P0001' && msg.includes('CLASE_INACTIVA')) {
          return res.status(400).json({ error: 'Esta clase ya no acepta reservas' });
        }
        if (insertErr.code === '23505') {
          return res.status(409).json({ error: 'Ya reservaste esta clase' });
        }
        throw insertErr;
      }

      const newCount = (count ?? 0) + 1;
      const claseMapped = mapClaseRow(clase, { reservasCount: newCount });

      console.log(`✓ POST /api/clases/${claseId}/reservar — user ${user.id}`);
      res.status(201).json({
        success: true,
        reserva_id: reserva.id,
        clase: claseMapped,
      });
    } catch (err) {
      console.error('❌ Error POST /api/clases/:id/reservar:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createClasesRouter;
