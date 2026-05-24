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

async function resolveHostName(partido, supabaseAdmin) {
  const filters = [];
  if (partido.host_user_id) {
    filters.push(`supabase_user_id.eq.${partido.host_user_id}`);
  }
  if (partido.host_email) {
    filters.push(`email.eq."${String(partido.host_email).replace(/"/g, '\\"')}"`);
  }

  if (filters.length > 0) {
    const { data: perfil } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('nombre, email')
      .or(filters.join(','))
      .maybeSingle();

    if (perfil?.nombre) return perfil.nombre;
    if (perfil?.email) return perfil.email;
  }

  return partido.host_email ?? 'Anfitrión';
}

export function createPartidosRouter({ supabase, supabaseAdmin, getAuthenticatedUser }) {
  const router = express.Router();

  // GET /api/partidos/abiertos — public open matches list
  router.get('/abiertos', async (req, res) => {
    try {
      const today = getTodayArgentinaDate();

      const { data: partidos, error } = await supabaseAdmin
        .from('partidos')
        .select(`
          id,
          sede_id,
          host_user_id,
          host_email,
          fecha,
          hora,
          nivel,
          tipo,
          estado,
          max_jugadores,
          created_at,
          sedes ( nombre ),
          partidos_jugadores ( id )
        `)
        .eq('tipo', 'abierto')
        .eq('estado', 'abierto')
        .gte('fecha', today)
        .order('fecha', { ascending: true })
        .order('hora', { ascending: true });

      if (error) throw error;

      const result = await Promise.all(
        (partidos || []).map(async (partido) => {
          const hostNombre = await resolveHostName(partido, supabaseAdmin);
          const jugadoresActuales = partido.partidos_jugadores?.length ?? 0;

          return {
            id: partido.id,
            sede_id: partido.sede_id,
            sede_nombre: partido.sedes?.nombre ?? null,
            fecha: partido.fecha,
            hora: formatHora(partido.hora),
            nivel: partido.nivel,
            jugadores_actuales: jugadoresActuales,
            jugadores_count: jugadoresActuales,
            max_jugadores: partido.max_jugadores ?? 4,
            host_nombre: hostNombre,
            created_at: partido.created_at,
          };
        }),
      );

      res.json(result);
    } catch (err) {
      console.error('❌ Error GET /api/partidos/abiertos:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/partidos/:id/unirse — join an open match
  router.post('/:id/unirse', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      const { id } = req.params;

      const { data: partido, error: fetchErr } = await supabaseAdmin
        .from('partidos')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!partido) {
        return res.status(404).json({ error: 'Partido no encontrado' });
      }
      if (partido.tipo !== 'abierto') {
        return res.status(400).json({ error: 'Este partido no es un partido abierto' });
      }
      if (partido.estado !== 'abierto') {
        return res.status(400).json({ error: 'Este partido ya no acepta jugadores' });
      }

      const { data: existingJoin, error: existingErr } = await supabaseAdmin
        .from('partidos_jugadores')
        .select('id')
        .eq('partido_id', id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingErr) throw existingErr;
      if (existingJoin) {
        return res.status(409).json({ error: 'Ya estás unido a este partido' });
      }

      const { count, error: countErr } = await supabaseAdmin
        .from('partidos_jugadores')
        .select('*', { count: 'exact', head: true })
        .eq('partido_id', id);

      if (countErr) throw countErr;

      const maxJugadores = partido.max_jugadores ?? 4;
      if ((count ?? 0) >= maxJugadores) {
        return res.status(409).json({ error: 'El partido ya está completo' });
      }

      const { error: insertErr } = await supabaseAdmin
        .from('partidos_jugadores')
        .insert([{
          partido_id: id,
          user_id: user.id,
          email: user.email ?? null,
        }]);

      if (insertErr) throw insertErr;

      const newCount = (count ?? 0) + 1;
      if (newCount >= maxJugadores) {
        await supabaseAdmin
          .from('partidos')
          .update({ estado: 'completo' })
          .eq('id', id);
      }

      console.log(`✓ POST /api/partidos/${id}/unirse — ${user.email ?? user.id}`);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ Error POST /api/partidos/:id/unirse:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/partidos — create open match (or legacy tournament match)
  router.post('/', async (req, res) => {
    try {
      const { torneo_id, equipo_a_id, equipo_b_id, fecha_hora, cancha_id, sede_id, fecha, hora, nivel, tipo } = req.body;

      if (torneo_id) {
        const { data, error } = await supabase
          .from('partidos')
          .insert([{
            torneo_id,
            equipo_a_id,
            equipo_b_id,
            fecha_hora,
            cancha_id,
            sede_id,
            estado: 'pendiente',
          }])
          .select();

        if (error) throw error;
        return res.json(data);
      }

      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status).json({ error: authError });
      }

      if (!sede_id || !fecha || !hora || !nivel) {
        return res.status(400).json({ error: 'Faltan campos: sede_id, fecha, hora, nivel' });
      }

      const { data: partido, error: insertErr } = await supabaseAdmin
        .from('partidos')
        .insert([{
          sede_id: parseInt(sede_id, 10),
          host_user_id: user.id,
          host_email: user.email ?? null,
          fecha,
          hora,
          nivel,
          tipo: tipo ?? 'abierto',
          estado: 'abierto',
          max_jugadores: 4,
        }])
        .select('*')
        .single();

      if (insertErr) throw insertErr;

      const { error: hostJoinErr } = await supabaseAdmin
        .from('partidos_jugadores')
        .insert([{
          partido_id: partido.id,
          user_id: user.id,
          email: user.email ?? null,
        }]);

      if (hostJoinErr) throw hostJoinErr;

      const hostNombre = await resolveHostName(partido, supabaseAdmin);

      console.log(`✓ POST /api/partidos — partido abierto ${partido.id} por ${user.email ?? user.id}`);
      res.status(201).json({
        ...partido,
        hora: formatHora(partido.hora),
        sede_nombre: null,
        host_nombre: hostNombre,
        jugadores_actuales: 1,
        jugadores_count: 1,
      });
    } catch (err) {
      console.error('❌ Error POST /api/partidos:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export default createPartidosRouter;
