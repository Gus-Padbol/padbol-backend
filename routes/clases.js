import express from 'express';

function getTodayArgentinaDate() {
  const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const year = nowAR.getFullYear();
  const month = String(nowAR.getMonth() + 1).padStart(2, '0');
  const day = String(nowAR.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatHora(hora) {
  if (!hora) return null;
  return String(hora).slice(0, 5);
}

function parseClaseId(id) {
  const claseId = parseInt(id, 10);
  if (Number.isNaN(claseId)) return null;
  return claseId;
}

function normalizeCertificaciones(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function mapClaseRow(clase, reservasCount = 0) {
  const profesor = clase.profesores ?? null;
  const sede = clase.sedes ?? null;
  const cupoMax = clase.cupo_max ?? 4;
  const spotsDisponibles = Math.max(cupoMax - reservasCount, 0);

  return {
    id: clase.id,
    deporte: clase.deporte,
    nivel: clase.nivel,
    sede_id: clase.sede_id,
    sede_nombre: sede?.nombre ?? null,
    fecha: clase.fecha,
    hora: formatHora(clase.hora),
    duracion_minutos: clase.duracion_minutos ?? 60,
    precio: clase.precio,
    moneda: clase.moneda ?? 'ARS',
    cupo_max: cupoMax,
    reservas_count: reservasCount,
    spots_disponibles: spotsDisponibles,
    profesor_id: clase.profesor_id,
    profesor_nombre: profesor?.nombre ?? 'Profesor',
    profesor_foto_url: profesor?.foto_url ?? null,
    profesor_bio: profesor?.bio ?? '',
    profesor_certificaciones: normalizeCertificaciones(profesor?.certificaciones),
  };
}

export function createClasesRouter({ supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  // GET /api/clases/disponibles — upcoming classes with available spots
  router.get('/disponibles', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const today = getTodayArgentinaDate();

      const { data: clases, error } = await supabaseAdmin
        .from('clases')
        .select(`
          id,
          profesor_id,
          sede_id,
          deporte,
          nivel,
          fecha,
          hora,
          duracion_minutos,
          precio,
          moneda,
          cupo_max,
          estado,
          profesores ( id, nombre, bio, foto_url, certificaciones ),
          sedes ( id, nombre ),
          clases_reservas ( id )
        `)
        .eq('estado', 'disponible')
        .gte('fecha', today)
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true });

      if (error) throw error;

      const result = (clases || [])
        .map((clase) => {
          const reservasCount = clase.clases_reservas?.length ?? 0;
          return mapClaseRow(clase, reservasCount);
        })
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
          *,
          profesores ( id, nombre, bio, foto_url, certificaciones ),
          sedes ( id, nombre )
        `)
        .eq('id', claseId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!clase) {
        return res.status(404).json({ error: 'Clase no encontrada' });
      }
      if (clase.estado !== 'disponible') {
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

      const cupoMax = clase.cupo_max ?? 4;
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
      if (newCount >= cupoMax) {
        await supabaseAdmin
          .from('clases')
          .update({ estado: 'completa' })
          .eq('id', claseId);
      }

      const claseMapped = mapClaseRow(clase, newCount);

      console.log(`✓ POST /api/clases/${claseId}/reservar — ${user.email ?? user.id}`);
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
