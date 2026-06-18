import express from 'express';

function getTodayArgentinaDate() {
  const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const year = nowAR.getFullYear();
  const month = String(nowAR.getMonth() + 1).padStart(2, '0');
  const day = String(nowAR.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatHora(value) {
  if (!value) return null;
  return String(value).slice(0, 5);
}

function parseClaseId(id) {
  const claseId = Number.parseInt(String(id), 10);
  if (Number.isNaN(claseId)) return null;
  return claseId;
}

function normalizeCertificaciones(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function dateFromCreatedAt(createdAt) {
  if (!createdAt) return null;
  return String(createdAt).slice(0, 10);
}

function horaFromCreatedAt(createdAt) {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function mapClaseRow(clase, { reservasCount = 0, fecha = null, hora = null, horarioId = null } = {}) {
  const profesor = clase.profesores ?? null;
  const sede = clase.sedes ?? null;
  const cupoMax = clase.cupo_maximo ?? 4;
  const spotsDisponibles = Math.max(cupoMax - reservasCount, 0);
  const fallbackFecha = fecha ?? dateFromCreatedAt(clase.created_at);
  const fallbackHora = hora ?? horaFromCreatedAt(clase.created_at);

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
    fecha: fallbackFecha,
    hora: formatHora(fallbackHora),
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
  };
}

let cachedHorariosTable = undefined;

async function resolveHorariosTable(supabaseAdmin) {
  if (cachedHorariosTable !== undefined) {
    return cachedHorariosTable;
  }

  for (const table of ['clases_horarios', 'clases_disponibilidad']) {
    const { error } = await supabaseAdmin.from(table).select('id').limit(1);
    if (!error) {
      cachedHorariosTable = table;
      return table;
    }
  }

  cachedHorariosTable = null;
  return null;
}

async function fetchHorariosByClaseIds(supabaseAdmin, table, claseIds, today) {
  if (!table || claseIds.length === 0) return {};

  const { data, error } = await supabaseAdmin
    .from(table)
    .select('*')
    .in('clase_id', claseIds)
    .gte('fecha', today)
    .order('fecha', { ascending: true })
    .order('hora', { ascending: true });

  if (error) {
    console.warn(`⚠️ No se pudieron cargar horarios desde ${table}:`, error.message);
    return {};
  }

  const grouped = {};
  (data || []).forEach((row) => {
    const key = String(row.clase_id);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  });

  return grouped;
}

function expandClasesWithHorarios(clases, horariosByClaseId, today) {
  const expanded = [];

  clases.forEach((clase) => {
    const reservasCount = clase.clases_reservas?.length ?? 0;
    const horarios = horariosByClaseId[String(clase.id)] ?? [];

    if (horarios.length === 0) {
      const mapped = mapClaseRow(clase, { reservasCount });
      if (!mapped.fecha || mapped.fecha >= today) {
        expanded.push(mapped);
      }
      return;
    }

    horarios.forEach((horario) => {
      expanded.push(mapClaseRow(clase, {
        reservasCount,
        fecha: horario.fecha ?? dateFromCreatedAt(horario.created_at),
        hora: horario.hora ?? horaFromCreatedAt(horario.created_at),
        horarioId: horario.id ?? null,
      }));
    });
  });

  return expanded;
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
  profesores ( id, nombre, bio, foto_url, certificaciones ),
  sedes ( id, nombre, moneda ),
  clases_reservas ( id )
`;

export function createClasesRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  // GET /api/clases/disponibles — active classes with available spots
  router.get('/disponibles', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const today = getTodayArgentinaDate();

      const { data: clases, error } = await supabaseAdmin
        .from('clases')
        .select(CLASE_SELECT)
        .eq('activo', true)
        .order('created_at', { ascending: true });

      if (error) throw error;

      const horariosTable = await resolveHorariosTable(supabaseAdmin);
      const claseIds = (clases || []).map((clase) => clase.id);
      const horariosByClaseId = await fetchHorariosByClaseIds(
        supabaseAdmin,
        horariosTable,
        claseIds,
        today,
      );

      const result = expandClasesWithHorarios(clases || [], horariosByClaseId, today)
        .filter((clase) => clase.spots_disponibles > 0);

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/clases/disponibles:', err.message);
      res.status(500).json({ error: err.message });
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
          profesores ( id, nombre, bio, foto_url, certificaciones ),
          sedes ( id, nombre, moneda )
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

      if (insertErr) throw insertErr;

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
