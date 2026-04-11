import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3001;

// CORS
const corsOrigin = process.env.CORS_ORIGIN || 'https://padbol-match.netlify.app';
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Supabase (desde .env)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Twilio (desde .env)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// GET sedes
app.get('/api/sedes', async (req, res) => {
  try {
    console.log('📡 GET /api/sedes - Conectando a Supabase...');
    const { data, error } = await supabase
      .from('sedes')
      .select('*');
    
    console.log('📊 Respuesta Supabase:', { data, error });
    
    if (error) {
      console.error('❌ Error Supabase:', error);
      throw error;
    }
    
    console.log('✅ Sedes cargadas:', data);
    res.json(data || []);
  } catch (err) {
    console.error('❌ Error GET /api/sedes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET disponibilidad
app.get('/api/disponibilidad/:sede/:fecha', async (req, res) => {
  try {
    const { sede, fecha } = req.params;
    
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('sede', sede)
      .eq('fecha', fecha);
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST reserva
app.post('/api/reservas', async (req, res) => {
  try {
    const { sede, fecha, hora, cancha, nombre, email, whatsapp, nivel, precio, estado } = req.body;

    // Validar campos
    if (!sede || !fecha || !hora || !cancha || !nombre || !email || !whatsapp) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    // Verificar double-booking
    const { data: existentes, error: errCheck } = await supabase
      .from('reservas')
      .select('*')
      .eq('sede', sede)
      .eq('fecha', fecha)
      .eq('hora', hora)
      .eq('cancha', cancha);

    if (errCheck) throw errCheck;

    if (existentes && existentes.length > 0) {
      return res.status(409).json({ error: 'Este horario ya está reservado' });
    }

    // Crear reserva
    const { data, error } = await supabase
      .from('reservas')
      .insert([{
        sede,
        fecha,
        hora,
        cancha: parseInt(cancha),
        nombre,
        email,
        telefono: whatsapp,
        whatsapp,
        nivel: nivel || 'Principiante',
        precio: parseInt(precio),
        estado: estado || 'reservada',
      }])
      .select();

    if (error) throw error;

    console.log('✓ Reserva creada:', data);

    // Enviar WhatsApp (sandbox)
    try {
      await twilioClient.messages.create({
        from: 'whatsapp:+14155238886',
        to: `whatsapp:+${whatsapp}`,
        body: `✅ Reserva confirmada en ${sede}\nFecha: ${fecha}\nHora: ${hora}\nCancha: ${cancha}\nPrecio: $${precio}`,
      });
    } catch (twilio_err) {
      console.log('⚠️ WhatsApp sandbox (no envía reales):', twilio_err.message);
    }

    res.json(data);
  } catch (err) {
    console.error('❌ Error POST reserva:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET reservas
app.get('/api/reservas', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reservas')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET ingresos
app.get('/api/ingresos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reservas')
      .select('precio')
      .eq('estado', 'confirmada');

    if (error) throw error;

    const total = data.reduce((sum, r) => sum + (r.precio || 0), 0);
    res.json({ total, reservas: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT reserva
app.put('/api/reservas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { sede, fecha, hora, cancha, nombre, email, precio, duracion, estado } = req.body;

    const updates = {};
    if (sede     !== undefined) updates.sede     = sede;
    if (fecha    !== undefined) updates.fecha    = fecha;
    if (hora     !== undefined) updates.hora     = hora;
    if (cancha   !== undefined) updates.cancha   = cancha !== null ? parseInt(cancha) : null;
    if (nombre   !== undefined) updates.nombre   = nombre;
    if (email    !== undefined) updates.email    = email;
    if (precio   !== undefined) updates.precio   = precio !== null ? parseInt(precio) : null;
    if (duracion !== undefined) updates.duracion = duracion !== null ? parseInt(duracion) : null;
    if (estado   !== undefined) updates.estado   = estado;

    const { data, error } = await supabase
      .from('reservas')
      .update(updates)
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE reserva
app.delete('/api/reservas/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('reservas')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ mensaje: 'Reserva eliminada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== GENERADORES DE PARTIDOS =====

function generarRoundRobin(equipos, torneoId, sedeId) {
  const partidos = [];
  for (let i = 0; i < equipos.length; i++) {
    for (let j = i + 1; j < equipos.length; j++) {
      partidos.push({
        torneo_id: parseInt(torneoId),
        equipo_a_id: equipos[i].id,
        equipo_b_id: equipos[j].id,
        sede_id: sedeId || null,
        estado: 'pendiente',
        ronda: 1,
      });
    }
  }
  return partidos;
}

function generarKnockout(equipos, torneoId, sedeId) {
  // Random bracket seeding
  const shuffled = [...equipos].sort(() => Math.random() - 0.5);
  const partidos = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    partidos.push({
      torneo_id: parseInt(torneoId),
      equipo_a_id: shuffled[i].id,
      equipo_b_id: shuffled[i + 1].id,
      sede_id: sedeId || null,
      estado: 'pendiente',
      ronda: 1,
    });
  }
  // If odd number of teams, the last one gets a bye (no match generated for it)
  return partidos;
}

function generarGruposKnockout(equipos, torneoId, sedeId) {
  // Aim for ~4 teams per group, minimum 2 groups
  const numGrupos = Math.max(2, Math.round(equipos.length / 4));
  const grupos = Array.from({ length: numGrupos }, () => []);

  // Snake-draft distribution across groups
  equipos.forEach((eq, idx) => {
    grupos[idx % numGrupos].push(eq);
  });

  const letras = 'ABCDEFGH';
  const partidos = [];

  grupos.forEach((grupo, gIdx) => {
    const letra = letras[gIdx] || `G${gIdx + 1}`;
    for (let i = 0; i < grupo.length; i++) {
      for (let j = i + 1; j < grupo.length; j++) {
        partidos.push({
          torneo_id: parseInt(torneoId),
          equipo_a_id: grupo[i].id,
          equipo_b_id: grupo[j].id,
          sede_id: sedeId || null,
          estado: 'pendiente',
          ronda: 1,
          grupo: letra,
        });
      }
    }
  });

  return partidos;
}

// ===== TORNEOS =====
app.post('/api/torneos', async (req, res) => {
  try {
    const { nombre, sede_id, nivel_torneo, tipo_torneo, fecha_inicio, fecha_fin, cantidad_equipos, es_multisede, created_by } = req.body;

    const { data, error } = await supabase
      .from('torneos')
      .insert([{
        nombre,
        sede_id: sede_id || null,
        nivel_torneo,
        tipo_torneo,
        estado: 'planificacion',
        fecha_inicio,
        fecha_fin,
        cantidad_equipos,
        es_multisede,
        created_by,
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/torneos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('torneos')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/torneos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('torneos')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/torneos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, nivel_torneo, tipo_torneo, estado, fecha_inicio, fecha_fin } = req.body;

    const { data, error } = await supabase
      .from('torneos')
      .update({
        nombre,
        nivel_torneo,
        tipo_torneo,
        estado,
        fecha_inicio,
        fecha_fin,
        updated_at: new Date(),
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/torneos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('torneos')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ mensaje: 'Torneo eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/torneos/:id/generar-partidos
// Reads all equipos for the torneo, generates matches based on tipo_torneo,
// saves them to partidos, and sets the torneo estado to 'en_curso'.
// Requires 'ronda' (int, nullable) and 'grupo' (text, nullable) columns on partidos table.
app.post('/api/torneos/:id/generar-partidos', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: torneo, error: errTorneo } = await supabase
      .from('torneos')
      .select('*')
      .eq('id', id)
      .single();
    if (errTorneo) throw errTorneo;

    const { data: equipos, error: errEquipos } = await supabase
      .from('equipos')
      .select('*')
      .eq('torneo_id', parseInt(id))
      .order('created_at', { ascending: true });
    if (errEquipos) throw errEquipos;

    if (!equipos || equipos.length < 2) {
      return res.status(400).json({ error: 'Se necesitan al menos 2 equipos para generar partidos' });
    }

    let partidosData;
    switch (torneo.tipo_torneo) {
      case 'round_robin':
        partidosData = generarRoundRobin(equipos, id, torneo.sede_id);
        break;
      case 'knockout':
        partidosData = generarKnockout(equipos, id, torneo.sede_id);
        break;
      case 'grupos_knockout':
        partidosData = generarGruposKnockout(equipos, id, torneo.sede_id);
        break;
      default:
        partidosData = generarRoundRobin(equipos, id, torneo.sede_id);
    }

    const { data: partidos, error: errPartidos } = await supabase
      .from('partidos')
      .insert(partidosData)
      .select();
    if (errPartidos) throw errPartidos;

    await supabase.from('torneos').update({ estado: 'en_curso' }).eq('id', id);

    console.log(`✅ ${partidos.length} partidos generados para torneo ${id} (${torneo.tipo_torneo})`);
    res.json({ partidos, total: partidos.length, formato: torneo.tipo_torneo });
  } catch (err) {
    console.error('❌ Error generar-partidos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== RANKINGS =====
// GET /api/rankings?scope=local|nacional|internacional&sede_id=X&categoria=Y
app.get('/api/rankings', async (req, res) => {
  const { scope = 'internacional', sede_id, categoria } = req.query;

  try {
    // 1. Load finalizado torneos filtered by scope
    const SCOPE_NIVELES = {
      local:         ['club', 'club_oficial', 'club_no_oficial'],
      nacional:      ['nacional'],
      internacional: ['internacional', 'mundial'],
    };
    const nivelesPermitidos = SCOPE_NIVELES[scope] || SCOPE_NIVELES.internacional;

    let torneosQuery = supabase
      .from('torneos')
      .select('id, sede_id, nivel_torneo, nombre')
      .eq('estado', 'finalizado')
      .in('nivel_torneo', nivelesPermitidos);

    if (scope === 'local' && sede_id) {
      torneosQuery = torneosQuery.eq('sede_id', parseInt(sede_id));
    }

    const { data: torneos, error: errT } = await torneosQuery;
    if (errT) throw errT;
    if (!torneos?.length) return res.json([]);

    const torneoIds = torneos.map(t => t.id);

    // 2. Load tabla_puntos for those torneos
    const { data: puntos, error: errP } = await supabase
      .from('tabla_puntos')
      .select('torneo_id, equipo_id, posicion, puntos')
      .in('torneo_id', torneoIds);
    if (errP) throw errP;
    if (!puntos?.length) return res.json([]);

    // 3. Load equipos
    const equipoIds = [...new Set(puntos.map(p => p.equipo_id))];
    const { data: equipos, error: errE } = await supabase
      .from('equipos')
      .select('id, nombre, jugadores')
      .in('id', equipoIds);
    if (errE) throw errE;

    const equipoMap = {};
    (equipos || []).forEach(e => { equipoMap[e.id] = e; });

    // 4. Aggregate per player (keyed by email when available, else by name)
    const playerMap = {};

    puntos.forEach(p => {
      const equipo = equipoMap[p.equipo_id];
      if (!equipo) return;
      const jugadores = Array.isArray(equipo.jugadores) ? equipo.jugadores : [];

      if (jugadores.length === 0) {
        // Fallback: team-level entry when no individual player data
        const key = `equipo:${equipo.id}`;
        if (!playerMap[key]) {
          playerMap[key] = { nombre: equipo.nombre, email: null, pais: null, foto_url: null, nivel: null, sede_id: null, equipo_nombre: equipo.nombre, puntos_total: 0, torneos_count: 0 };
        }
        playerMap[key].puntos_total += p.puntos;
        playerMap[key].torneos_count += 1;
      } else {
        jugadores.forEach(j => {
          const key = j.email || j.nombre;
          if (!key) return;
          if (!playerMap[key]) {
            playerMap[key] = { nombre: j.nombre || key, email: j.email || null, pais: null, foto_url: null, nivel: null, sede_id: null, equipo_nombre: equipo.nombre, puntos_total: 0, torneos_count: 0 };
          }
          playerMap[key].puntos_total += p.puntos;
          playerMap[key].torneos_count += 1;
        });
      }
    });

    // 5. Enrich with jugadores_perfil where emails are known
    const emails = Object.values(playerMap).map(p => p.email).filter(Boolean);
    if (emails.length > 0) {
      const { data: perfiles } = await supabase
        .from('jugadores_perfil')
        .select('email, nombre, pais, foto_url, sede_id, nivel')
        .in('email', emails);

      (perfiles || []).forEach(perfil => {
        const entry = playerMap[perfil.email];
        if (!entry) return;
        entry.foto_url = perfil.foto_url || null;
        entry.pais     = perfil.pais     || null;
        entry.nivel    = perfil.nivel    || null;
        entry.sede_id  = perfil.sede_id  || null;
        entry.nombre   = perfil.nombre   || entry.nombre;
      });
    }

    // 6. Filter by categoria
    let result = Object.values(playerMap);
    if (categoria) result = result.filter(p => p.nivel === categoria);

    // 7. Sort by puntos_total desc, then torneos_count desc
    result.sort((a, b) => b.puntos_total - a.puntos_total || b.torneos_count - a.torneos_count);

    res.json(result);
  } catch (err) {
    console.error('❌ Error GET /api/rankings:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== FINALIZAR TORNEO =====
// Required SQL migration:
// create table tabla_puntos (
//   id serial primary key,
//   torneo_id int references torneos(id) on delete cascade,
//   equipo_id int references equipos(id) on delete cascade,
//   posicion int not null,
//   puntos int not null,
//   created_at timestamp default now(),
//   unique(torneo_id, equipo_id)
// );

const BASE_PUNTOS = {
  club_no_oficial:  10,
  club_oficial:     30,
  nacional:        100,
  internacional:   300,
  mundial:        1000,
};

// Index 0 = 1st place, 1 = 2nd, ... 9 = 10th
const POSICION_MULT = [1.0, 0.6, 0.4, 0.25, 0.15, 0.10, 0.05, 0.05, 0.05, 0.05];

function calcularClasificacion(equipos, partidos) {
  const stats = {};
  equipos.forEach(eq => {
    stats[eq.id] = { jj: 0, g: 0, p: 0, pts: 0, sg: 0, sp: 0, gg: 0, gp: 0 };
  });

  partidos.forEach(partido => {
    if (partido.estado !== 'finalizado' || !partido.resultado) return;
    const res = typeof partido.resultado === 'string'
      ? JSON.parse(partido.resultado)
      : partido.resultado;
    const sets = [res.set1, res.set2, res.set3].filter(Boolean);

    let sgA = 0, sgB = 0, ggA = 0, ggB = 0;
    sets.forEach(set => {
      const [a, b] = set.split('-').map(Number);
      ggA += a; ggB += b;
      if (a > b) sgA++; else sgB++;
    });

    const eqA = stats[partido.equipo_a_id];
    const eqB = stats[partido.equipo_b_id];
    if (!eqA || !eqB) return;

    eqA.jj++; eqB.jj++;
    eqA.sg += sgA; eqA.sp += sgB; eqA.gg += ggA; eqA.gp += ggB;
    eqB.sg += sgB; eqB.sp += sgA; eqB.gg += ggB; eqB.gp += ggA;

    if (sgA > sgB) { eqA.g++; eqB.p++; eqA.pts += 3; }
    else           { eqB.g++; eqA.p++; eqB.pts += 3; }
  });

  return equipos
    .map(eq => ({ ...eq, ...stats[eq.id] }))
    .sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const dA = a.sg - a.sp, dB = b.sg - b.sp;
      if (dB !== dA) return dB - dA;
      return (b.gg - b.gp) - (a.gg - a.gp);
    });
}

app.post('/api/torneos/:id/finalizar', async (req, res) => {
  try {
    const { id } = req.params;

    // Load torneo
    const { data: torneo, error: errTorneo } = await supabase
      .from('torneos').select('*').eq('id', id).single();
    if (errTorneo) throw errTorneo;

    // Load equipos & partidos
    const [{ data: equipos, error: errEq }, { data: partidos, error: errPart }] = await Promise.all([
      supabase.from('equipos').select('*').eq('torneo_id', parseInt(id)),
      supabase.from('partidos').select('*').eq('torneo_id', parseInt(id)),
    ]);
    if (errEq) throw errEq;
    if (errPart) throw errPart;

    // Validate all matches finished
    const pendientes = (partidos || []).filter(p => p.estado !== 'finalizado');
    if (pendientes.length > 0) {
      return res.status(400).json({
        error: `Hay ${pendientes.length} partido(s) sin finalizar. Completa todos los resultados antes de finalizar el torneo.`,
      });
    }

    // Calculate final standings
    const clasificacion = calcularClasificacion(equipos || [], partidos || []);

    // Assign ranking points
    const base = BASE_PUNTOS[torneo.nivel_torneo] ?? 10;
    const puntosData = clasificacion.map((eq, idx) => ({
      torneo_id: parseInt(id),
      equipo_id: eq.id,
      posicion: idx + 1,
      puntos: Math.round(base * (POSICION_MULT[idx] ?? 0.05)),
    }));

    // Delete previous entries for this torneo (idempotent), then insert
    await supabase.from('tabla_puntos').delete().eq('torneo_id', parseInt(id));
    const { error: errPuntos } = await supabase.from('tabla_puntos').insert(puntosData);
    if (errPuntos) throw errPuntos;

    // Update equipos with their final puntos_ranking
    await Promise.all(
      puntosData.map(({ equipo_id, puntos }) =>
        supabase.from('equipos').update({ puntos_ranking: puntos }).eq('id', equipo_id)
      )
    );

    // Mark torneo as finalizado
    const { data: torneoFinal, error: errFinal } = await supabase
      .from('torneos')
      .update({ estado: 'finalizado', updated_at: new Date() })
      .eq('id', id)
      .select()
      .single();
    if (errFinal) throw errFinal;

    console.log(`🏆 Torneo ${id} finalizado. ${puntosData.length} equipos clasificados.`);
    res.json({
      torneo: torneoFinal,
      clasificacion: puntosData,
    });
  } catch (err) {
    console.error('❌ Error finalizar torneo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== JUGADORES =====
app.post('/api/jugadores', async (req, res) => {
  try {
    const { user_id, nombre, email, documento, tipo_documento, nacionalidad, fecha_nacimiento, foto_url, pierna_habil, bio } = req.body;

    const { data, error } = await supabase
      .from('jugadores')
      .insert([{
        user_id,
        nombre,
        email,
        documento,
        tipo_documento,
        nacionalidad,
        fecha_nacimiento,
        foto_url,
        pierna_habil,
        bio,
        estado: 'activo',
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jugadores', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('jugadores')
      .select('*')
      .eq('estado', 'activo')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jugadores/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('jugadores')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jugadores/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, email, documento, nacionalidad, fecha_nacimiento, foto_url, pierna_habil, bio } = req.body;

    const { data, error } = await supabase
      .from('jugadores')
      .update({
        nombre,
        email,
        documento,
        nacionalidad,
        fecha_nacimiento,
        foto_url,
        pierna_habil,
        bio,
        updated_at: new Date(),
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== JUGADORES TORNEO =====
app.post('/api/torneos/:torneo_id/jugadores', async (req, res) => {
  try {
    const { torneo_id } = req.params;
    const { nombre, email, user_id, numero_camiseta, es_capitan, pais } = req.body;

    const { data, error } = await supabase
      .from('jugadores_torneo')
      .insert([{
        torneo_id: parseInt(torneo_id),
        nombre,
        email,
        user_id,
        numero_camiseta,
        es_capitan,
        pais: pais || null,
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/torneos/:torneo_id/jugadores', async (req, res) => {
  try {
    const { torneo_id } = req.params;

    const { data, error } = await supabase
      .from('jugadores_torneo')
      .select('*')
      .eq('torneo_id', parseInt(torneo_id));

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/jugadores_torneo/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('jugadores_torneo')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ mensaje: 'Jugador removido del torneo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== EQUIPOS =====
app.post('/api/torneos/:torneo_id/equipos', async (req, res) => {
  try {
    const { torneo_id } = req.params;
    const { nombre, sede_id, jugadores } = req.body;

    const { data, error } = await supabase
      .from('equipos')
      .insert([{
        torneo_id: parseInt(torneo_id),
        nombre,
        sede_id,
        jugadores: jugadores || [],
        puntos_totales: 0,
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/torneos/:torneo_id/equipos', async (req, res) => {
  try {
    const { torneo_id } = req.params;

    const [{ data: equipos, error: errE }, { data: grupoPartidos }] = await Promise.all([
      supabase.from('equipos').select('*').eq('torneo_id', parseInt(torneo_id)).order('puntos_totales', { ascending: false }),
      supabase.from('partidos').select('equipo_a_id, equipo_b_id, grupo').eq('torneo_id', parseInt(torneo_id)).not('grupo', 'is', null),
    ]);
    if (errE) throw errE;

    // Derive equipo → grupo from partidos (grupo is stored on partidos, not equipos)
    const grupoMap = {};
    (grupoPartidos || []).forEach(p => {
      if (p.grupo) {
        if (p.equipo_a_id) grupoMap[p.equipo_a_id] = p.grupo;
        if (p.equipo_b_id) grupoMap[p.equipo_b_id] = p.grupo;
      }
    });

    const result = (equipos || []).map(eq => ({ ...eq, grupo: grupoMap[eq.id] || null }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/equipos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, jugadores, puntos_totales } = req.body;

    const { data, error } = await supabase
      .from('equipos')
      .update({
        nombre,
        jugadores,
        puntos_totales,
        updated_at: new Date(),
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/equipos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('equipos')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ mensaje: 'Equipo eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== PARTIDOS =====
app.post('/api/partidos', async (req, res) => {
  try {
    const { torneo_id, equipo_a_id, equipo_b_id, fecha_hora, cancha_id, sede_id } = req.body;

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
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/torneos/:torneo_id/partidos', async (req, res) => {
  try {
    const { torneo_id } = req.params;

    const { data, error } = await supabase
      .from('partidos')
      .select(`
        *,
        equipo_a:equipos!equipo_a_id(nombre),
        equipo_b:equipos!equipo_b_id(nombre)
      `)
      .eq('torneo_id', parseInt(torneo_id))
      .order('fecha_hora', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partidos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('partidos')
      .select(`
        *,
        equipo_a:equipos!equipo_a_id(nombre),
        equipo_b:equipos!equipo_b_id(nombre),
        games(*)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}); 

app.put('/api/partidos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, resultado } = req.body;

    // Obtener el partido
    const { data: partido, error: errPartido } = await supabase
      .from('partidos')
      .select('*')
      .eq('id', id)
      .single();

    if (errPartido) throw errPartido;

    // Parsear resultado
    const res_obj = JSON.parse(resultado);
    const set1 = res_obj.set1.split('-').map(Number);
    const set2 = res_obj.set2.split('-').map(Number);
    const set3 = res_obj.set3.split('-').map(Number);

    // Contar sets ganados
    let setsA = 0, setsB = 0;
    if (set1[0] > set1[1]) setsA++; else setsB++;
    if (set2[0] > set2[1]) setsA++; else setsB++;
    if (set3[0] > set3[1]) setsA++; else setsB++;

    const gamesA = set1[0] + set2[0] + set3[0];
    const gamesB = set1[1] + set2[1] + set3[1];

    // Actualizar partido
    const { error: errUpdate } = await supabase
      .from('partidos')
      .update({
        estado,
        resultado,
        updated_at: new Date(),
      })
      .eq('id', id);

    if (errUpdate) throw errUpdate;

    // Actualizar equipos
    const { data: equipoA } = await supabase
      .from('equipos')
      .select('*')
      .eq('id', partido.equipo_a_id)
      .single();

    const { data: equipoB } = await supabase
      .from('equipos')
      .select('*')
      .eq('id', partido.equipo_b_id)
      .single();

    if (equipoA) {
      await supabase
        .from('equipos')
        .update({
          sets_ganados: (equipoA.sets_ganados || 0) + setsA,
          sets_perdidos: (equipoA.sets_perdidos || 0) + setsB,
          games_ganados: (equipoA.games_ganados || 0) + gamesA,
          games_perdidos: (equipoA.games_perdidos || 0) + gamesB,
          puntos_totales: (equipoA.puntos_totales || 0) + (setsA > setsB ? 3 : 0),
          partidos_jugados: (equipoA.partidos_jugados || 0) + 1,
        })
        .eq('id', partido.equipo_a_id);
    }

    if (equipoB) {
      await supabase
        .from('equipos')
        .update({
          sets_ganados: (equipoB.sets_ganados || 0) + setsB,
          sets_perdidos: (equipoB.sets_perdidos || 0) + setsA,
          games_ganados: (equipoB.games_ganados || 0) + gamesB,
          games_perdidos: (equipoB.games_perdidos || 0) + gamesA,
          puntos_totales: (equipoB.puntos_totales || 0) + (setsB > setsA ? 3 : 0),
          partidos_jugados: (equipoB.partidos_jugados || 0) + 1,
        })
        .eq('id', partido.equipo_b_id);
    }

    const { data: updatedPartido } = await supabase
      .from('partidos')
      .select('*')
      .eq('id', id)
      .single();

    res.json(updatedPartido);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== GAMES =====
app.post('/api/partidos/:partido_id/games', async (req, res) => {
  try {
    const { partido_id } = req.params;
    const { numero_game, equipo_a_score, equipo_b_score } = req.body;

    const { data, error } = await supabase
      .from('games')
      .insert([{
        partido_id: parseInt(partido_id),
        numero_game,
        equipo_a_score,
        equipo_b_score,
        estado: 'finalizado',
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partidos/:partido_id/games', async (req, res) => {
  try {
    const { partido_id } = req.params;

    const { data, error } = await supabase
      .from('games')
      .select('*')
      .eq('partido_id', parseInt(partido_id))
      .order('numero_game', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/games/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { equipo_a_score, equipo_b_score, estado } = req.body;

    const { data, error } = await supabase
      .from('games')
      .update({
        equipo_a_score,
        equipo_b_score,
        estado,
        updated_at: new Date(),
      })
      .eq('id', id)
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CONFIG PUNTOS =====
// Required SQL migration:
// create table config_puntos (
//   id serial primary key,
//   clave text unique not null,
//   valor jsonb not null,
//   updated_at timestamp default now()
// );
// insert into config_puntos (clave, valor) values
//   ('niveles', '{"club_no_oficial":10,"club_oficial":30,"nacional":100,"internacional":300,"mundial":1000}'),
//   ('posiciones', '{"1":100,"2":60,"3":40,"4":25,"5":15,"6":10,"7":5,"8":5,"9":5,"10":5}');

const CONFIG_DEFAULTS = {
  niveles:    { club_no_oficial: 10, club_oficial: 30, nacional: 100, internacional: 300, mundial: 1000 },
  posiciones: { 1: 100, 2: 60, 3: 40, 4: 25, 5: 15, 6: 10, 7: 5, 8: 5, 9: 5, 10: 5 },
};

app.get('/api/config/puntos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('config_puntos').select('clave, valor');
    if (error) throw error;
    if (!data?.length) return res.json(CONFIG_DEFAULTS);
    const result = { ...CONFIG_DEFAULTS };
    data.forEach(row => { result[row.clave] = row.valor; });
    res.json(result);
  } catch (err) {
    console.error('❌ Error GET /api/config/puntos:', err.message);
    res.json(CONFIG_DEFAULTS); // always return usable defaults
  }
});

app.put('/api/config/puntos', async (req, res) => {
  try {
    const { niveles, posiciones } = req.body;
    const rows = [];
    if (niveles)    rows.push({ clave: 'niveles',    valor: niveles,    updated_at: new Date() });
    if (posiciones) rows.push({ clave: 'posiciones', valor: posiciones, updated_at: new Date() });
    if (!rows.length) return res.status(400).json({ error: 'No data provided' });

    const { error } = await supabase
      .from('config_puntos')
      .upsert(rows, { onConflict: 'clave' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error PUT /api/config/puntos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Padbol Match API running on port ${PORT}`);
  console.log(`📊 Supabase: ${SUPABASE_URL}`);
  console.log(`💬 Twilio WhatsApp: whatsapp:+14155238886`);
});