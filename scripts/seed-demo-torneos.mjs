#!/usr/bin/env node
/**
 * Seed idempotente de torneos demo (prefijo "DEMO |") para staging / entornos controlados.
 *
 * NO se ejecuta automáticamente. Requiere ALLOW_DEMO_SEED=true explícito.
 * No toca torneos que no empiecen con "DEMO |". No modifica el torneo #23.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DEMO_PREFIX = 'DEMO |';
const PROTECTED_TORNEO_IDS = new Set([23]);

const DEMO_TEAMS = [
  {
    nombre: 'Argentina',
    jugadores: [
      { nombre: 'Gus Miguens', email: 'gus.demo@padbol.com', es_capitan: true },
      { nombre: 'Pablo Demo', email: 'pablo.demo@padbol.com' },
    ],
  },
  {
    nombre: 'España',
    jugadores: [
      { nombre: 'Carlos Ruiz', email: 'carlos.demo@padbol.com', es_capitan: true },
      { nombre: 'Miguel Torres', email: 'miguel.demo@padbol.com' },
    ],
  },
  {
    nombre: 'Francia',
    jugadores: [
      { nombre: 'Jean Martin', email: 'jean.demo@padbol.com', es_capitan: true },
      { nombre: 'Lucas Bernard', email: 'lucas.demo@padbol.com' },
    ],
  },
  {
    nombre: 'Italia',
    jugadores: [
      { nombre: 'Marco Rossi', email: 'marco.demo@padbol.com', es_capitan: true },
      { nombre: 'Paolo Bianchi', email: 'paolo.demo@padbol.com' },
    ],
  },
  {
    nombre: 'Brasil',
    jugadores: [
      { nombre: 'Joao Silva', email: 'joao.demo@padbol.com', es_capitan: true },
      { nombre: 'Pedro Santos', email: 'pedro.demo@padbol.com' },
    ],
  },
  {
    nombre: 'Uruguay',
    jugadores: [
      { nombre: 'Diego Pérez', email: 'diego.demo@padbol.com', es_capitan: true },
      { nombre: 'Martín Suárez', email: 'martin.demo@padbol.com' },
    ],
  },
  {
    nombre: 'Portugal',
    jugadores: [
      { nombre: 'Tiago Costa', email: 'tiago.demo@padbol.com', es_capitan: true },
      { nombre: 'Bruno Almeida', email: 'bruno.demo@padbol.com' },
    ],
  },
  {
    nombre: 'Alemania',
    jugadores: [
      { nombre: 'Hans Müller', email: 'hans.demo@padbol.com', es_capitan: true },
      { nombre: 'Lukas Becker', email: 'lukas.demo@padbol.com' },
    ],
  },
];

const GROUP_A = ['Argentina', 'España', 'Francia', 'Italia'];
const GROUP_B = ['Brasil', 'Uruguay', 'Portugal', 'Alemania'];

const BASE_PUNTOS = {
  club_no_oficial: 10,
  club_oficial: 30,
  nacional: 100,
  internacional: 300,
  mundial: 1000,
};

const POSICION_MULT = [1.0, 0.6, 0.4, 0.25, 0.15, 0.10, 0.05, 0.05, 0.05, 0.05];

const DEMO_TORNEO_NAMES = [
  `${DEMO_PREFIX} Liga Round Robin`,
  `${DEMO_PREFIX} Eliminación Directa`,
  `${DEMO_PREFIX} Solo Grupos`,
  `${DEMO_PREFIX} Grupos + Eliminatoria`,
  `${DEMO_PREFIX} Liga + Playoff`,
];

function log(msg) {
  console.log(`[demo-seed] ${msg}`);
}

function warn(msg) {
  console.warn(`[demo-seed] ⚠️  ${msg}`);
}

function fail(msg) {
  console.error(`[demo-seed] ❌ ${msg}`);
  process.exit(1);
}

function envFlag(name) {
  return String(process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function assertEnvironmentAllowed() {
  if (!envFlag('ALLOW_DEMO_SEED')) {
    fail('Abortado: definí ALLOW_DEMO_SEED=true para ejecutar este script.');
  }

  if (process.env.NODE_ENV === 'production' && !envFlag('ALLOW_PRODUCTION_DEMO_SEED')) {
    fail(
      'Abortado: NODE_ENV=production. Definí ALLOW_PRODUCTION_DEMO_SEED=true solo con confirmación explícita.',
    );
  }

  const url = String(process.env.SUPABASE_URL ?? '');
  if (/onrender\.com/i.test(url) && !envFlag('ALLOW_PRODUCTION_DEMO_SEED')) {
    fail(
      'Abortado: SUPABASE_URL parece producción (Render). Usá staging o ALLOW_PRODUCTION_DEMO_SEED=true con confirmación.',
    );
  }
}

function createSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    fail('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function winnerResult(winnerIsA) {
  return winnerIsA
    ? { set1: '6-4', set2: '6-3' }
    : { set1: '4-6', set2: '3-6' };
}

function roundRobinPairs(ids) {
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      pairs.push([ids[i], ids[j]]);
    }
  }
  return pairs;
}

function calcularClasificacion(equipos, partidos) {
  const stats = {};
  equipos.forEach((eq) => {
    stats[eq.id] = { jj: 0, g: 0, p: 0, pts: 0, sg: 0, sp: 0, gg: 0, gp: 0 };
  });

  partidos.forEach((partido) => {
    if (partido.estado !== 'finalizado' || !partido.resultado) return;
    const res = typeof partido.resultado === 'string'
      ? JSON.parse(partido.resultado)
      : partido.resultado;

    if (res.goles_a != null && res.goles_b != null) {
      const eqA = stats[partido.equipo_a_id];
      const eqB = stats[partido.equipo_b_id];
      if (!eqA || !eqB) return;
      eqA.jj++; eqB.jj++;
      eqA.gg += Number(res.goles_a); eqA.gp += Number(res.goles_b);
      eqB.gg += Number(res.goles_b); eqB.gp += Number(res.goles_a);
      if (Number(res.goles_a) > Number(res.goles_b)) {
        eqA.g++; eqB.p++; eqA.pts += 3; eqA.sg += 1;
      } else {
        eqB.g++; eqA.p++; eqB.pts += 3; eqB.sg += 1;
      }
      return;
    }

    const sets = [res.set1, res.set2, res.set3].filter(Boolean);
    let sgA = 0; let sgB = 0; let ggA = 0; let ggB = 0;
    sets.forEach((set) => {
      const [a, b] = String(set).split('-').map(Number);
      ggA += a; ggB += b;
      if (a > b) sgA += 1; else sgB += 1;
    });

    const eqA = stats[partido.equipo_a_id];
    const eqB = stats[partido.equipo_b_id];
    if (!eqA || !eqB) return;

    eqA.jj++; eqB.jj++;
    eqA.sg += sgA; eqA.sp += sgB; eqA.gg += ggA; eqA.gp += ggB;
    eqB.sg += sgB; eqB.sp += sgA; eqB.gg += ggB; eqB.gp += ggA;

    if (sgA > sgB) { eqA.g++; eqB.p++; eqA.pts += 3; } else { eqB.g++; eqA.p++; eqB.pts += 3; }
  });

  return equipos
    .map((eq) => ({ ...eq, ...stats[eq.id] }))
    .sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const dA = a.sg - a.sp; const dB = b.sg - b.sp;
      if (dB !== dA) return dB - dA;
      return (b.gg - b.gp) - (a.gg - a.gp);
    });
}

async function findTorneoByName(supabase, nombre) {
  const { data, error } = await supabase
    .from('torneos')
    .select('id, nombre, estado, tipo_torneo')
    .eq('nombre', nombre)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function assertDemoTorneoName(nombre) {
  if (!nombre?.startsWith(DEMO_PREFIX)) {
    throw new Error(`Refusing non-demo torneo: ${nombre}`);
  }
}

async function deleteDemoTorneoCascade(supabase, torneoId, nombre) {
  assertDemoTorneoName(nombre);
  if (PROTECTED_TORNEO_IDS.has(Number(torneoId))) {
    throw new Error(`Refusing to delete protected torneo id ${torneoId}`);
  }

  log(`Re-seed: eliminando demo existente "${nombre}" (id ${torneoId})…`);
  await supabase.from('tabla_puntos').delete().eq('torneo_id', torneoId);
  await supabase.from('partidos').delete().eq('torneo_id', torneoId);
  await supabase.from('equipos').delete().eq('torneo_id', torneoId);
  const { error } = await supabase.from('torneos').delete().eq('id', torneoId);
  if (error) throw error;
}

async function ensureDemoTorneoSlot(supabase, nombre, reseed) {
  const existing = await findTorneoByName(supabase, nombre);
  if (!existing) return null;

  assertDemoTorneoName(existing.nombre);
  if (PROTECTED_TORNEO_IDS.has(Number(existing.id))) {
    fail(`Torneo protegido #${existing.id} coincide con nombre demo — revisá nombres.`);
  }

  if (reseed) {
    await deleteDemoTorneoCascade(supabase, existing.id, existing.nombre);
    return null;
  }

  log(`Ya existe "${nombre}" (id ${existing.id}) — omitiendo creación.`);
  return existing;
}

async function insertTorneo(supabase, row) {
  log(`Creando torneo: ${row.nombre}`);
  const { data, error } = await supabase.from('torneos').insert([row]).select('id, nombre, tipo_torneo').single();
  if (error) throw error;
  return data;
}

async function insertEquipos(supabase, torneoId, sedeId) {
  const rows = DEMO_TEAMS.map((team) => ({
    torneo_id: torneoId,
    nombre: team.nombre,
    sede_id: sedeId,
    jugadores: team.jugadores,
    puntos_totales: 0,
    inscripcion_estado: 'confirmado',
  }));

  const { data, error } = await supabase.from('equipos').insert(rows).select('id, nombre');
  if (error) throw error;

  const byName = {};
  (data || []).forEach((eq) => { byName[eq.nombre] = eq.id; });
  return byName;
}

function buildFechaHora(dayOffset, hour) {
  const d = new Date('2026-07-01T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function insertPartidos(supabase, torneoId, sedeId, partidos) {
  if (partidos.length === 0) return [];

  let day = 0;
  const rows = partidos.map((p, index) => {
    const row = {
      torneo_id: torneoId,
      sede_id: sedeId,
      equipo_a_id: p.equipo_a_id,
      equipo_b_id: p.equipo_b_id,
      estado: 'finalizado',
      resultado: p.resultado ?? winnerResult(p.winnerIsA !== false),
      fecha_hora: p.fecha_hora ?? buildFechaHora(day + Math.floor(index / 3), 14 + (index % 5)),
      grupo: p.grupo ?? null,
      ronda: p.ronda ?? null,
      fase: p.fase ?? null,
      instancia: p.instancia ?? null,
      nombre_fase: p.nombre_fase ?? null,
      es_final: p.es_final ?? null,
    };

    if (p.define_campeon === true) row.define_campeon = true;
    if (p.consagra_campeon === true) row.consagra_campeon = true;
    if (p.es_partido_consagracion === true) row.es_partido_consagracion = true;

    return row;
  });

  const { data, error } = await supabase.from('partidos').insert(rows).select('id, ronda, grupo, fase');
  if (error) throw error;
  return data || [];
}

async function finalizeDemoTorneo(supabase, torneoId, nombre) {
  assertDemoTorneoName(nombre);
  log(`Finalizando demo "${nombre}" (id ${torneoId})…`);

  const [{ data: torneo, error: errT }, { data: equipos, error: errE }, { data: partidos, error: errP }] =
    await Promise.all([
      supabase.from('torneos').select('*').eq('id', torneoId).single(),
      supabase.from('equipos').select('*').eq('torneo_id', torneoId),
      supabase.from('partidos').select('*').eq('torneo_id', torneoId),
    ]);
  if (errT) throw errT;
  if (errE) throw errE;
  if (errP) throw errP;

  const pendientes = (partidos || []).filter((p) => p.estado !== 'finalizado');
  if (pendientes.length > 0) {
    throw new Error(`${pendientes.length} partido(s) sin finalizar en torneo ${torneoId}`);
  }

  const clasificacion = calcularClasificacion(equipos || [], partidos || []);
  const base = BASE_PUNTOS[torneo.nivel_torneo] ?? 10;
  const puntosData = clasificacion.map((eq, idx) => ({
    torneo_id: torneoId,
    equipo_id: eq.id,
    posicion: idx + 1,
    puntos: Math.round(base * (POSICION_MULT[idx] ?? 0.05)),
  }));

  await supabase.from('tabla_puntos').delete().eq('torneo_id', torneoId);
  const { error: errIns } = await supabase.from('tabla_puntos').insert(puntosData);
  if (errIns) throw errIns;

  await Promise.all(
    puntosData.map(({ equipo_id, puntos }) =>
      supabase.from('equipos').update({ puntos_ranking: puntos }).eq('id', equipo_id),
    ),
  );

  const { error: errFin } = await supabase
    .from('torneos')
    .update({ estado: 'finalizado', updated_at: new Date().toISOString() })
    .eq('id', torneoId);
  if (errFin) throw errFin;

  log(`Finalizado id ${torneoId}: ${puntosData.length} filas en tabla_puntos.`);
}

function idsForNames(byName, names) {
  return names.map((n) => {
    const id = byName[n];
    if (!id) throw new Error(`Equipo no encontrado: ${n}`);
    return id;
  });
}

function buildGroupPartidos(byName, groupLetter, teamNames, preferWinners = []) {
  const ids = idsForNames(byName, teamNames);
  const pairs = roundRobinPairs(ids);
  const preferSet = new Set(preferWinners);

  return pairs.map(([a, b], idx) => {
    const nameA = teamNames.find((n) => byName[n] === a);
    const nameB = teamNames.find((n) => byName[n] === b);
    let winnerIsA = idx % 2 === 0;
    if (preferSet.has(nameA)) winnerIsA = true;
    else if (preferSet.has(nameB)) winnerIsA = false;

    return {
      equipo_a_id: a,
      equipo_b_id: b,
      grupo: groupLetter,
      ronda: 1,
      fase: 'grupos',
      winnerIsA,
    };
  });
}

async function seedLigaRoundRobin(supabase, sedeId, reseed, finalize) {
  const nombre = `${DEMO_PREFIX} Liga Round Robin`;
  const existing = await ensureDemoTorneoSlot(supabase, nombre, reseed);
  if (existing) return { nombre, id: existing.id, skipped: true };

  const torneo = await insertTorneo(supabase, {
    nombre,
    sede_id: sedeId,
    tipo_torneo: 'round_robin',
    nivel_torneo: 'club_oficial',
    categoria: 'Primera',
    deporte: 'padbol',
    fecha_inicio: '2026-07-01',
    fecha_fin: '2026-07-14',
    cantidad_equipos: 8,
    es_multisede: false,
    estado: 'en_curso',
  });

  const byName = await insertEquipos(supabase, torneo.id, sedeId);
  const allIds = idsForNames(byName, DEMO_TEAMS.map((t) => t.nombre));

  const partidos = roundRobinPairs(allIds).map(([a, b], idx) => {
    const nameA = DEMO_TEAMS.find((t) => byName[t.nombre] === a)?.nombre;
    const nameB = DEMO_TEAMS.find((t) => byName[t.nombre] === b)?.nombre;
    let winnerIsA = true;
    if (nameA === 'Argentina') winnerIsA = true;
    else if (nameB === 'Argentina') winnerIsA = false;
    else winnerIsA = idx % 2 === 0;

    const row = {
      equipo_a_id: a,
      equipo_b_id: b,
      ronda: 1,
      fase: 'liga',
      winnerIsA,
    };

    if (nameA === 'Argentina' && nameB === 'Francia') {
      row.define_campeon = true;
      row.fase = 'liga';
      row.nombre_fase = 'Fecha decisiva';
      row.winnerIsA = true;
    }

    return row;
  });

  await insertPartidos(supabase, torneo.id, sedeId, partidos);
  if (finalize) await finalizeDemoTorneo(supabase, torneo.id, nombre);
  return { nombre, id: torneo.id, partidos: partidos.length, skipped: false };
}

async function seedEliminacionDirecta(supabase, sedeId, reseed, finalize) {
  const nombre = `${DEMO_PREFIX} Eliminación Directa`;
  const existing = await ensureDemoTorneoSlot(supabase, nombre, reseed);
  if (existing) return { nombre, id: existing.id, skipped: true };

  const torneo = await insertTorneo(supabase, {
    nombre,
    sede_id: sedeId,
    tipo_torneo: 'knockout',
    nivel_torneo: 'club_oficial',
    categoria: 'Primera',
    deporte: 'padbol',
    fecha_inicio: '2026-07-02',
    fecha_fin: '2026-07-08',
    cantidad_equipos: 8,
    es_multisede: false,
    estado: 'en_curso',
  });

  const byName = await insertEquipos(supabase, torneo.id, sedeId);
  const id = (n) => byName[n];

  const partidos = [
    { equipo_a_id: id('Argentina'), equipo_b_id: id('Alemania'), ronda: 'cuartos', fase: 'eliminatoria', winnerIsA: true },
    { equipo_a_id: id('España'), equipo_b_id: id('Uruguay'), ronda: 'cuartos', fase: 'eliminatoria', winnerIsA: true },
    { equipo_a_id: id('Francia'), equipo_b_id: id('Portugal'), ronda: 'cuartos', fase: 'eliminatoria', winnerIsA: true },
    { equipo_a_id: id('Italia'), equipo_b_id: id('Brasil'), ronda: 'cuartos', fase: 'eliminatoria', winnerIsA: false },
    { equipo_a_id: id('Argentina'), equipo_b_id: id('España'), ronda: 'semifinal', fase: 'eliminatoria', winnerIsA: true },
    { equipo_a_id: id('Francia'), equipo_b_id: id('Brasil'), ronda: 'semifinal', fase: 'eliminatoria', winnerIsA: true },
    { equipo_a_id: id('Argentina'), equipo_b_id: id('Francia'), ronda: 'final', fase: 'final', es_final: true, winnerIsA: true },
  ];

  await insertPartidos(supabase, torneo.id, sedeId, partidos);
  if (finalize) await finalizeDemoTorneo(supabase, torneo.id, nombre);
  return { nombre, id: torneo.id, partidos: partidos.length, skipped: false };
}

async function seedSoloGrupos(supabase, sedeId, reseed, finalize) {
  const nombre = `${DEMO_PREFIX} Solo Grupos`;
  const existing = await ensureDemoTorneoSlot(supabase, nombre, reseed);
  if (existing) return { nombre, id: existing.id, skipped: true };

  const torneo = await insertTorneo(supabase, {
    nombre,
    sede_id: sedeId,
    tipo_torneo: 'grupos',
    nivel_torneo: 'club_oficial',
    categoria: 'Primera',
    deporte: 'padbol',
    fecha_inicio: '2026-07-03',
    fecha_fin: '2026-07-10',
    cantidad_equipos: 8,
    es_multisede: false,
    estado: 'en_curso',
  });

  const byName = await insertEquipos(supabase, torneo.id, sedeId);

  const partidosA = buildGroupPartidos(byName, 'A', GROUP_A, ['Argentina', 'España']);
  const partidosB = buildGroupPartidos(byName, 'B', GROUP_B, ['Brasil', 'Francia']);

  await insertPartidos(supabase, torneo.id, sedeId, [...partidosA, ...partidosB]);
  if (finalize) await finalizeDemoTorneo(supabase, torneo.id, nombre);
  return { nombre, id: torneo.id, partidos: partidosA.length + partidosB.length, skipped: false };
}

async function seedGruposEliminatoria(supabase, sedeId, reseed, finalize) {
  const nombre = `${DEMO_PREFIX} Grupos + Eliminatoria`;
  const existing = await ensureDemoTorneoSlot(supabase, nombre, reseed);
  if (existing) return { nombre, id: existing.id, skipped: true };

  const torneo = await insertTorneo(supabase, {
    nombre,
    sede_id: sedeId,
    tipo_torneo: 'grupos_knockout',
    nivel_torneo: 'club_oficial',
    categoria: 'Primera',
    deporte: 'padbol',
    fecha_inicio: '2026-07-04',
    fecha_fin: '2026-07-12',
    cantidad_equipos: 8,
    es_multisede: false,
    estado: 'en_curso',
  });

  const byName = await insertEquipos(supabase, torneo.id, sedeId);
  const partidosA = buildGroupPartidos(byName, 'A', GROUP_A, ['Argentina', 'España']);
  const partidosB = buildGroupPartidos(byName, 'B', GROUP_B, ['Francia', 'Brasil']);

  const knockout = [
    { equipo_a_id: byName.Argentina, equipo_b_id: byName.Brasil, ronda: 'semifinal', fase: 'eliminatoria', winnerIsA: true },
    { equipo_a_id: byName.España, equipo_b_id: byName.Francia, ronda: 'semifinal', fase: 'eliminatoria', winnerIsA: true },
    { equipo_a_id: byName.Argentina, equipo_b_id: byName.España, ronda: 'final', fase: 'final', es_final: true, winnerIsA: true },
  ];

  await insertPartidos(supabase, torneo.id, sedeId, [...partidosA, ...partidosB, ...knockout]);
  if (finalize) await finalizeDemoTorneo(supabase, torneo.id, nombre);
  return { nombre, id: torneo.id, partidos: partidosA.length + partidosB.length + knockout.length, skipped: false };
}

async function seedLigaPlayoff(supabase, sedeId, reseed, finalize) {
  const nombre = `${DEMO_PREFIX} Liga + Playoff`;
  const existing = await ensureDemoTorneoSlot(supabase, nombre, reseed);
  if (existing) return { nombre, id: existing.id, skipped: true };

  const torneo = await insertTorneo(supabase, {
    nombre,
    sede_id: sedeId,
    tipo_torneo: 'liga_playoff',
    nivel_torneo: 'club_oficial',
    categoria: 'Primera',
    deporte: 'padbol',
    fecha_inicio: '2026-07-05',
    fecha_fin: '2026-07-15',
    cantidad_equipos: 8,
    es_multisede: false,
    estado: 'en_curso',
  });

  const byName = await insertEquipos(supabase, torneo.id, sedeId);
  const allIds = idsForNames(byName, DEMO_TEAMS.map((t) => t.nombre));

  const liga = roundRobinPairs(allIds).map(([a, b], idx) => {
    const nameA = DEMO_TEAMS.find((t) => byName[t.nombre] === a)?.nombre;
    let winnerIsA = true;
    if (nameA === 'España' || nameA === 'Argentina' || nameA === 'Francia' || nameA === 'Brasil') {
      winnerIsA = true;
    } else {
      winnerIsA = idx % 2 === 0;
    }
    return {
      equipo_a_id: a,
      equipo_b_id: b,
      ronda: 'liga',
      fase: 'liga',
      winnerIsA,
    };
  });

  const playoff = [
    { equipo_a_id: byName.España, equipo_b_id: byName.Brasil, ronda: 'semifinal', fase: 'playoff', winnerIsA: true },
    { equipo_a_id: byName.Argentina, equipo_b_id: byName.Francia, ronda: 'semifinal', fase: 'playoff', winnerIsA: false },
    { equipo_a_id: byName.España, equipo_b_id: byName.Francia, ronda: 'final', fase: 'final', es_final: true, winnerIsA: true },
  ];

  await insertPartidos(supabase, torneo.id, sedeId, [...liga, ...playoff]);
  if (finalize) await finalizeDemoTorneo(supabase, torneo.id, nombre);
  return { nombre, id: torneo.id, partidos: liga.length + playoff.length, skipped: false };
}

async function main() {
  assertEnvironmentAllowed();

  const sedeId = Number(process.env.DEMO_SEED_SEDE_ID ?? 1);
  const reseed = envFlag('DEMO_RESEED');
  const finalize = envFlag('FINALIZE_DEMOS');

  log('Iniciando seed de torneos demo (sin tocar torneos fuera de "DEMO |")…');
  log(`Sede: ${sedeId} | reseed=${reseed} | finalize=${finalize}`);
  log(`Torneos demo esperados: ${DEMO_TORNEO_NAMES.join('; ')}`);
  warn('No se modifica el torneo #23 ni torneos sin prefijo DEMO |.');

  const supabase = createSupabaseAdmin();

  const seeders = [
    seedLigaRoundRobin,
    seedEliminacionDirecta,
    seedSoloGrupos,
    seedGruposEliminatoria,
    seedLigaPlayoff,
  ];

  const results = [];
  for (const seedFn of seeders) {
    try {
      const result = await seedFn(supabase, sedeId, reseed, finalize);
      results.push(result);
    } catch (err) {
      warn(`${seedFn.name}: ${err.message}`);
      if (/column.*does not exist/i.test(err.message)) {
        warn('Posible columna opcional ausente en partidos (p. ej. define_campeon). Revisá docs/demo-torneos.md');
      }
      results.push({ nombre: seedFn.name, error: err.message });
    }
  }

  log('— Resumen —');
  results.forEach((r) => {
    if (r.error) {
      log(`✗ ${r.nombre}: ERROR — ${r.error}`);
    } else if (r.skipped) {
      log(`↷ ${r.nombre} (id ${r.id}): omitido (ya existía)`);
    } else {
      log(`✓ ${r.nombre} (id ${r.id}): ${r.partidos ?? '?'} partidos${finalize ? ', finalizado' : ''}`);
    }
  });

  log('Seed demo completado (sin ejecución automática en deploy).');
}

main().catch((err) => {
  fail(err.message || String(err));
});
