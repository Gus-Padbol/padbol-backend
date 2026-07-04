#!/usr/bin/env node
/**
 * Seed mínimo para probar POST manual de resultado de torneo.
 *
 * Crea exactamente: 1 torneo "DEMO | Manual Result Test", 2 equipos, 1 partido pendiente.
 * Sin scoreboard, sin tabla_puntos, sin finalizar torneo.
 *
 * NO se ejecuta automáticamente. Ver docs/demo-torneos.md.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DEMO_PREFIX = 'DEMO |';
const DEMO_TORNEO_NAME = `${DEMO_PREFIX} Manual Result Test`;
const PROTECTED_TORNEO_IDS = new Set([21, 23, 27, 28, 29]);

const DEMO_TEAMS = [
  {
    nombre: 'Demo Manual A',
    jugadores: [
      { nombre: 'Capitán Demo A', email: 'capitan-a.demo@padbol.com', es_capitan: true },
      { nombre: 'Jugador Demo A2', email: 'jugador-a2.demo@padbol.com' },
    ],
  },
  {
    nombre: 'Demo Manual B',
    jugadores: [
      { nombre: 'Capitán Demo B', email: 'capitan-b.demo@padbol.com', es_capitan: true },
      { nombre: 'Jugador Demo B2', email: 'jugador-b2.demo@padbol.com' },
    ],
  },
];

function log(msg) {
  console.log(`[manual-result-demo] ${msg}`);
}

function warn(msg) {
  console.warn(`[manual-result-demo] ⚠️  ${msg}`);
}

function fail(msg) {
  console.error(`[manual-result-demo] ❌ ${msg}`);
  process.exit(1);
}

function envFlag(name) {
  return String(process.env[name] ?? '').trim().toLowerCase() === 'true';
}

function normalizeTargetEnv() {
  return String(process.env.DEMO_TARGET_ENV ?? '').trim().toLowerCase();
}

export function assertEnvironmentAllowed() {
  if (!envFlag('ALLOW_DEMO_SEED')) {
    fail('Abortado: definí ALLOW_DEMO_SEED=true para ejecutar este script.');
  }

  if (!envFlag('ALLOW_MANUAL_RESULT_DEMO')) {
    fail('Abortado: definí ALLOW_MANUAL_RESULT_DEMO=true para ejecutar este script.');
  }

  if (envFlag('FINALIZE_DEMOS')) {
    fail('Abortado: FINALIZE_DEMOS no está soportado en este script.');
  }

  const url = String(process.env.SUPABASE_URL ?? '').trim();
  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '',
  ).trim();

  if (!url || !key) {
    fail('Abortado: faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  }

  const targetEnv = normalizeTargetEnv();
  if (targetEnv === 'production') {
    if (!envFlag('ALLOW_PRODUCTION_DEMO_SEED')) {
      fail(
        'Abortado: DEMO_TARGET_ENV=production requiere ALLOW_PRODUCTION_DEMO_SEED=true con confirmación explícita.',
      );
    }
    if (!envFlag('ALLOW_PRODUCTION_MANUAL_RESULT_DEMO')) {
      fail(
        'Abortado: DEMO_TARGET_ENV=production requiere además ALLOW_PRODUCTION_MANUAL_RESULT_DEMO=true.',
      );
    }
    warn('Ejecutando contra entorno production — confirmación explícita detectada.');
  } else if (!['local', 'staging'].includes(targetEnv)) {
    fail('Abortado: DEMO_TARGET_ENV debe ser "local" o "staging" (o "production" solo con doble confirmación).');
  }

  if (process.env.NODE_ENV === 'production' && targetEnv !== 'production') {
    fail('Abortado: NODE_ENV=production pero DEMO_TARGET_ENV no es production.');
  }
}

export function createSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    fail('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function assertExactDemoTorneoName(nombre) {
  if (nombre !== DEMO_TORNEO_NAME) {
    throw new Error(`Refusing non-exact demo torneo: ${nombre}`);
  }
  if (!nombre.startsWith(DEMO_PREFIX)) {
    throw new Error(`Refusing non-demo torneo: ${nombre}`);
  }
}

function assertNotProtectedTorneoId(torneoId) {
  if (PROTECTED_TORNEO_IDS.has(Number(torneoId))) {
    throw new Error(`Refusing protected torneo id ${torneoId}`);
  }
}

export async function findExistingDemo(supabase) {
  const { data, error } = await supabase
    .from('torneos')
    .select('id, nombre, estado, sede_id, tipo_torneo')
    .eq('nombre', DEMO_TORNEO_NAME)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  assertExactDemoTorneoName(data.nombre);
  assertNotProtectedTorneoId(data.id);
  return data;
}

async function loadDemoPartido(supabase, torneoId) {
  const { data, error } = await supabase
    .from('partidos')
    .select('id, torneo_id, estado, equipo_a_id, equipo_b_id, resultado')
    .eq('torneo_id', torneoId)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function deleteDemoCascade(supabase, torneoId, nombre) {
  assertExactDemoTorneoName(nombre);
  assertNotProtectedTorneoId(torneoId);

  log(`Eliminando demo "${nombre}" (id ${torneoId})…`);

  await supabase.from('tabla_puntos').delete().eq('torneo_id', torneoId);
  await supabase.from('partidos').delete().eq('torneo_id', torneoId);
  await supabase.from('equipos').delete().eq('torneo_id', torneoId);

  const { error } = await supabase.from('torneos').delete().eq('id', torneoId);
  if (error) throw error;

  log(`Demo eliminado (id ${torneoId}).`);
}

function buildFechaHora() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 2);
  return d.toISOString();
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

export async function createDemoManualResultTest(supabase, sedeId) {
  log(`Creando torneo: ${DEMO_TORNEO_NAME}`);

  const { data: torneo, error: errTorneo } = await supabase
    .from('torneos')
    .insert([{
      nombre: DEMO_TORNEO_NAME,
      sede_id: sedeId,
      tipo_torneo: 'round_robin',
      nivel_torneo: 'club_no_oficial',
      categoria: 'Primera',
      deporte: 'padbol',
      fecha_inicio: new Date().toISOString().slice(0, 10),
      fecha_fin: null,
      cantidad_equipos: 2,
      es_multisede: false,
      estado: 'en_curso',
    }])
    .select('id, nombre, sede_id, estado')
    .single();

  if (errTorneo) throw errTorneo;
  assertNotProtectedTorneoId(torneo.id);

  const byName = await insertEquipos(supabase, torneo.id, sedeId);
  const equipoAId = byName['Demo Manual A'];
  const equipoBId = byName['Demo Manual B'];

  if (!equipoAId || !equipoBId) {
    throw new Error('No se pudieron crear los equipos demo.');
  }

  const { data: partido, error: errPartido } = await supabase
    .from('partidos')
    .insert([{
      torneo_id: torneo.id,
      sede_id: sedeId,
      equipo_a_id: equipoAId,
      equipo_b_id: equipoBId,
      estado: 'pendiente',
      fecha_hora: buildFechaHora(),
      ronda: 1,
      fase: 'liga',
      grupo: null,
    }])
    .select('id, estado, equipo_a_id, equipo_b_id')
    .single();

  if (errPartido) throw errPartido;

  return {
    torneo_id: torneo.id,
    partido_id: partido.id,
    equipo_a_id: partido.equipo_a_id,
    equipo_b_id: partido.equipo_b_id,
    sede_id: sedeId,
    created: true,
  };
}

function printSummary(result) {
  const apiBase = String(process.env.DEMO_API_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
  const { torneo_id: T, partido_id: P } = result;

  log('— Resumen —');
  log(`torneo_id=${result.torneo_id}`);
  log(`partido_id=${result.partido_id}`);
  log(`equipo_a_id=${result.equipo_a_id}`);
  log(`equipo_b_id=${result.equipo_b_id}`);
  log(`sede_id=${result.sede_id}`);
  if (result.skipped) log('acción=omitido (demo ya existía)');
  else if (result.deleted) log('acción=eliminado');
  else log(`acción=${result.created ? 'creado' : 'desconocido'}`);

  log('— GET sugeridos (solo lectura) —');
  console.log(`
curl -sS "${apiBase}/health"
curl -sS "${apiBase}/api/torneos/${T}"
curl -sS "${apiBase}/api/torneos/${T}/equipos"
curl -sS "${apiBase}/api/torneos/${T}/partidos"
curl -sS -H "Authorization: Bearer \$JWT" "${apiBase}/api/torneos/${T}/permisos"

# Esperado en partidos: estado pendiente, scoreboard_id null, marcador_disponible false
# POST manual (NO ejecutar sin autorización):
# curl -X POST -H "Authorization: Bearer \$JWT" -H "Content-Type: application/json" \\
#   -d '{"goles_a":2,"goles_b":0}' \\
#   "${apiBase}/api/torneos/${T}/partidos/${P}/resultado"
`.trim());
}

async function main() {
  assertEnvironmentAllowed();

  const sedeId = Number(process.env.DEMO_SEED_SEDE_ID ?? 1);
  const reseed = envFlag('DEMO_RESEED');
  const deleteOnly = envFlag('DEMO_DELETE_ONLY');

  if (reseed && deleteOnly) {
    fail('Abortado: no uses DEMO_RESEED=true y DEMO_DELETE_ONLY=true a la vez.');
  }

  log(`Iniciando seed mínimo manual result | sede=${sedeId} | target=${normalizeTargetEnv()}`);
  log(`Torneo objetivo: ${DEMO_TORNEO_NAME}`);
  warn(`No modifica torneos protegidos: ${[...PROTECTED_TORNEO_IDS].join(', ')}`);

  const supabase = createSupabaseAdmin();
  const existing = await findExistingDemo(supabase);

  if (existing && deleteOnly) {
    await deleteDemoCascade(supabase, existing.id, existing.nombre);
    printSummary({ torneo_id: existing.id, partido_id: null, deleted: true, sede_id: sedeId });
    return;
  }

  if (existing && reseed) {
    await deleteDemoCascade(supabase, existing.id, existing.nombre);
  } else if (existing) {
    const partido = await loadDemoPartido(supabase, existing.id);
    log(`Ya existe "${DEMO_TORNEO_NAME}" (id ${existing.id}) — omitiendo creación.`);
    printSummary({
      torneo_id: existing.id,
      partido_id: partido?.id ?? null,
      equipo_a_id: partido?.equipo_a_id ?? null,
      equipo_b_id: partido?.equipo_b_id ?? null,
      sede_id: existing.sede_id ?? sedeId,
      skipped: true,
    });
    return;
  }

  const result = await createDemoManualResultTest(supabase, sedeId);
  printSummary(result);
  log('Seed mínimo completado.');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => fail(err.message || String(err)));
}
