import http from 'http';
import ws from 'ws';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import twilio from 'twilio';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import Stripe from 'stripe';
import cron from 'node-cron';
import { createEquiposUsuarioRouter } from './routes/equipos.js';
import { createHubRouter } from './routes/hub.js';
import { createMembresiasRouter } from './routes/membresias.js';
import {
  buildPartidoAbiertoInsertRow,
  buildCapitanFields,
  buildReservaInsertRow,
  createPartidosAbiertosRouter,
  createPartidosRouter,
  buildDisponibilidadSlots,
  fetchDisponibilidadOccupancy,
  filterBlockingReservas,
  isCourtBlocked,
  isReservaSlotUniqueViolation,
  logPartidoCanchaBody,
  parsePositiveInt,
  resolvePartidoCanchaNombre,
  resolveReservaCanchaStorageText,
} from './routes/partidos.js';
import { reservaHoraInicioFromRow, reservaHoraFinFromRow, reservaMatchesSede } from './utils/reservasColumns.js';
import { createClasesRouter } from './routes/clases.js';
import { mountSedesProfileRoutes } from './routes/sedesProfile.js';
import { mountSurgeRoutes } from './routes/surge.js';
import { mountCanchasRoutes } from './routes/canchas.js';
import { mountRankingsLeaderboardRoutes } from './routes/rankingsLeaderboard.js';
import { mountResenasRoutes } from './routes/resenas.js';
import {
  mountReputacionRoutes,
  procesarReputacionTrasCancelacion,
  assertJugadorNoSuspendidoPg,
  resolveUserIdByEmailPg,
} from './routes/reputacion.js';
import { mountNotificacionesRoutes } from './routes/notificaciones.js';
import { mountJugadorReputacionRoutes } from './routes/jugadorReputacion.js';
import { mountTorneosFinalizadosRoutes } from './routes/torneosFinalizados.js';
import { mountReservasDiagnosticoRoutes } from './routes/reservasDiagnostico.js';
import { mountReservasHoldCleanupRoutes } from './routes/reservasHoldCleanup.js';
import { mountSedeExtrasRoutes } from './routes/sedeExtras.js';
import { mountTorneoInteresRoutes } from './routes/torneoInteres.js';
import { mountListaEsperaGeneralRoutes } from './routes/listaEsperaGeneral.js';
import { mountLogrosPremiosRoutes } from './routes/logrosPremios.js';
import { mountLigasPremiosRoutes } from './routes/ligasPremios.js';
import { enrichSedeWithHeroPhoto } from './utils/sedeHero.js';
import { SEDE_APP_SELECT } from './utils/sedePublicSelect.js';
import { mountMercadoPagoWebhookRoutes } from './routes/mercadopagoWebhook.js';
import { mountStripeWebhookRoutes } from './routes/stripeWebhook.js';
import {
  ensureReservaPendienteParaMpPg,
  normalizeCrearPreferenciaReservaInput,
  persistMercadoPagoPreferencePg,
  persistStripeCheckoutSessionPg,
} from './routes/reservaPendienteMp.js';
import { assertCancelReservaOwnerCompat, assertReservaOwnerOrAdmin, buildAdminReservaPutUpdates, buildNormalUserReservaPutUpdates, resolveReservaAccess } from './lib/reservaAccess.js';
import {
  applyReservasListScopeToQuery,
  isAdminClubOrSuper,
  requireAdminUser,
  requireAuthenticatedUser,
  resolveAuthRoleForUser,
  resolveIngresosListScope,
  resolveReservasListScope,
} from './lib/authAccess.js';
import { quoteReservaPrice, assertClientPrecioMatchesQuote } from './lib/pricing/quoteReservaPrice.js';
import { envConfigured, maskEmail, maskPhone, safeQueryLog, summarizeError } from './lib/safeLog.js';
import { applySecurityHeaders } from './lib/httpSecurity.js';
import { buildClientErrorPayload, logServerError, sanitizeClientErrorMessage, sendHttpError } from './lib/httpErrors.js';
import {
  EQUIPO_TORNEO_PUBLIC_SELECT,
  JUGADOR_PUBLIC_SELECT,
  JUGADOR_TORNEO_PUBLIC_SELECT,
  legacyWriteDisabled,
  mapEquipoTorneoPublicRow,
  mapJugadorPublicRow,
  mapJugadorTorneoPublicRow,
  mapPartidoTorneoPublicRow,
  mapTorneoPublicRow,
  PARTIDO_TORNEO_DETAIL_PUBLIC_SELECT,
  PARTIDO_TORNEO_PUBLIC_SELECT,
  TORNEO_PUBLIC_SELECT,
} from './lib/dto/legacyPublic.js';
import {
  buildClasificacion,
  buildFinalRankingForTorneo,
  buildTablaLivePublicResponse,
  buildTablaPuntosFromRankingRows,
} from './lib/torneos/clasificacionService.js';
import {
  assertKnockoutBracketTeamCount,
  buildKnockoutBracketMatches,
  linkBracketMatches,
  mergeBracketLinks,
} from './lib/torneos/knockoutBracketService.js';
import { generarKnockoutDesdeGrupos } from './lib/torneos/generarKnockoutDesdeGruposService.js';
import {
  mapMisReservaRow,
  mapReservaDetailDto,
  mapReservaListDto,
  RESERVA_ADMIN_SELECT,
  RESERVA_OWNER_SELECT,
} from './lib/dto/reservaDto.js';
import {
  chiviRateLimit,
  aiRateLimit,
  configureRateLimitTrustProxy,
  isRateLimitDisabled,
  paymentsRateLimit,
  publicReadRateLimitIfMatch,
  pushTokensRateLimit,
  reservasWriteRateLimit,
} from './lib/rateLimit.js';
import { toStripeMinorUnits, normalizeStripeCurrency } from './lib/stripe/stripeAmount.js';
import { isSolicitudPendienteActiva } from './lib/solicitudesPartidoHorario.js';
import { mountReservaQrRoutes } from './routes/reservaQr.js';
import { mountJugadorPerfilPublicoRoutes } from './routes/jugadorPerfilPublico.js';
import { mountPushRoutes } from './routes/push.js';
import { mountArenaRoutes } from './routes/arena.js';
import {
  notifyReservaConfirmada,
  notifyTorneoInscripcionConfirmada,
  notifyTorneoSorteoPublicado,
} from './utils/push.js';
import { createXpRouter } from './src/routes/xp.js';
import { createChiviRouter } from './src/routes/chivi.js';
import { createAiRouter } from './src/routes/ai.js';
import { createArenaRouter } from './src/routes/arena.js';
import { createRangosRouter } from './src/routes/rangos.js';
import { initReservasCron } from './src/cron/reservasCron.js';
import { initReservasHoldCleanupCron } from './src/cron/reservasHoldCleanup.js';
import { mountScoreboardRoutes, initScoreboardSocket } from './routes/scoreboard.js';
import { generarScoreboardsForTorneo } from './src/scoreboard/scoreboardTorneoService.js';
import {
  actualizarRango,
  collectUserIdsFromEquipos,
} from './src/rangos/rangosService.js';

globalThis.WebSocket = ws;

dotenv.config();

const app = express();
configureRateLimitTrustProxy(app);
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: [
      'https://padbolmatch.com',
      'https://www.padbolmatch.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:8081',
      'https://padbol-match.netlify.app',
      'https://padbol-match-9abn.vercel.app',
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
const PORT = 3001;

// CORS
app.use(cors({
  origin: [
    'https://padbolmatch.com',
    'https://www.padbolmatch.com',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8081',
    'exp://192.168.0.19:8081',
    'https://expo.dev',
    'https://padbol-match.netlify.app',
    'https://padbol-match-9abn.vercel.app',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
}));
applySecurityHeaders(app);
app.use(express.json({
  verify: (req, _res, buf) => {
    if (req.originalUrl === '/api/webhooks/stripe' || req.url === '/api/webhooks/stripe') {
      req.rawBody = buf;
    }
  },
}));

app.use(publicReadRateLimitIfMatch);

// Supabase (desde .env)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '',
).trim();
const SUPABASE_CLIENT_GLOBAL_OPTS = {
  global: { WebSocket: ws },
  realtime: { enabled: false },
};
const SUPABASE_ADMIN_CLIENT_OPTS = {
  ...SUPABASE_CLIENT_GLOBAL_OPTS,
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};

function createSupabaseClientSafe(url, key, options, label) {
  if (!url || !key) {
    console.error(`❌ ${label} createClient skip: SUPABASE_URL o key faltante`);
    return null;
  }
  try {
    return createClient(url, key, options);
  } catch (err) {
    console.error(`❌ ${label} createClient init failed:`, err?.message || err);
    return null;
  }
}

let supabase = createSupabaseClientSafe(
  SUPABASE_URL,
  SUPABASE_KEY,
  SUPABASE_CLIENT_GLOBAL_OPTS,
  'supabase (anon)',
);
/** Service role (sb_secret_…): REST/storage; Realtime desactivado (sin suscripciones). */
let supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createSupabaseClientSafe(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_ADMIN_CLIENT_OPTS,
        'supabaseAdmin',
      )
    : supabase;
if (!supabaseAdmin) {
  supabaseAdmin = supabase;
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  SUPABASE_SERVICE_ROLE_KEY no está configurado — supabaseAdmin usa SUPABASE_KEY (RLS puede bloquear pagos)');
}

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const pgPool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    })
  : null;

async function verifyPgPoolConnection() {
  if (!pgPool) {
    console.log('🐘 PostgreSQL: DATABASE_URL no configurada — pgPool no disponible');
    return false;
  }
  try {
    await pgPool.query('SELECT 1 AS ok');
    console.log('🐘 PostgreSQL: pgPool conectado OK (DATABASE_URL)');
    return true;
  } catch (err) {
    console.error('🐘 PostgreSQL: pgPool falló al conectar:', err?.message || err);
    if (err?.code) console.error('🐘 PostgreSQL: código:', err.code);
    return false;
  }
}

/** Lee credenciales MP de sedes vía Postgres (evita PolicyAgent/RLS de Supabase REST). */
async function fetchSedeMpCredentialsPg(sedeId) {
  const sid = parseInt(String(sedeId), 10);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  if (!pgPool) {
    const err = new Error('DATABASE_URL no configurada — pgPool no disponible para leer mp_access_token');
    err.status = 503;
    console.error('[POST /api/crear-preferencia] pg query abortado:', err.message);
    throw err;
  }
  console.log('[POST /api/crear-preferencia] pg query', {
    table: 'sedes',
    operation: 'select',
    client: 'pgPool',
    sede_id: sid,
  });
  try {
    const { rows } = await pgPool.query(
      'SELECT mp_access_token, mp_public_key FROM sedes WHERE id = $1',
      [sid],
    );
    const row = rows[0] ?? null;
    if (crearPreferenciaSupabaseLogActive) {
      console.log('[POST /api/crear-preferencia] pg query OK', {
        sedeId: sid,
        hasRow: Boolean(row),
        hasMpToken: Boolean(String(row?.mp_access_token || '').trim()),
      });
    }
    return row;
  } catch (err) {
    console.error('[POST /api/crear-preferencia] pg query error:', {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      sedeId: sid,
    });
    throw err;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mercado Pago
if (!process.env.MP_ACCESS_TOKEN) {
  console.warn('⚠️  MP_ACCESS_TOKEN no está configurado — los pagos fallarán en producción');
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY no está configurado — Chivi chat no funcionará (cargar en Render dashboard)');
}
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || '',
});

const stripeClient = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠️  STRIPE_SECRET_KEY no está configurado — Stripe Checkout no estará disponible');
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn('⚠️  STRIPE_WEBHOOK_SECRET no está configurado — el webhook Stripe rechazará eventos');
}

function normalizePaymentExtras(extras) {
  if (!Array.isArray(extras)) return [];

  return extras
    .map((extra) => ({
      id: extra.id,
      nombre: extra.nombre,
      precio: Number(extra.precio ?? 0),
      moneda: extra.moneda,
      categoria: extra.categoria,
      cantidad: Math.max(0, Number(extra.cantidad ?? extra.quantity ?? 0)),
    }))
    .filter((extra) => extra.cantidad > 0 && Number.isFinite(extra.precio));
}

function buildMercadoPagoItems({ titulo, moneda, pricing, extras = [] }) {
  const currency = moneda || 'ARS';
  const items = [{
    title: titulo,
    unit_price: Number(pricing?.base ?? 0),
    quantity: 1,
    currency_id: currency,
  }];

  for (const extra of normalizePaymentExtras(extras)) {
    items.push({
      title: extra.nombre,
      unit_price: extra.precio,
      quantity: extra.cantidad,
      currency_id: extra.moneda || currency,
    });
  }

  const fee = Number(pricing?.fee ?? 0);
  if (fee > 0) {
    items.push({
      title: 'Comisión plataforma (3%)',
      unit_price: fee,
      quantity: 1,
      currency_id: currency,
    });
  }

  return items;
}

function buildStripeLineItems({ titulo, moneda, pricing, extras = [] }) {
  const currency = normalizeStripeCurrency(moneda);

  const line_items = [{
    price_data: {
      currency,
      product_data: { name: titulo },
      unit_amount: toStripeMinorUnits(currency, pricing?.base ?? 0),
    },
    quantity: 1,
  }];

  for (const extra of normalizePaymentExtras(extras)) {
    line_items.push({
      price_data: {
        currency: normalizeStripeCurrency(extra.moneda || moneda),
        product_data: { name: extra.nombre },
        unit_amount: toStripeMinorUnits(extra.moneda || moneda, extra.precio),
      },
      quantity: extra.cantidad,
    });
  }

  const fee = Number(pricing?.fee ?? 0);
  if (fee > 0) {
    line_items.push({
      price_data: {
        currency,
        product_data: { name: 'Comisión plataforma (3%)' },
        unit_amount: toStripeMinorUnits(currency, fee),
      },
      quantity: 1,
    });
  }

  return line_items;
}

function computePartidoDeadlineCancel(fecha, hora) {
  const time = hora ? String(hora).slice(0, 5) : '00:00';
  const matchDate = new Date(`${fecha}T${time}:00-03:00`);
  if (Number.isNaN(matchDate.getTime())) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(matchDate.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

async function resolveMercadoPagoClient(sedeId) {
  if (!sedeId) return mpClient;

  const { data: sedeRow, error } = await supabaseAdmin
    .from('sedes')
    .select('mp_access_token')
    .eq('id', sedeId)
    .maybeSingle();
  if (error) throw error;

  if (sedeRow?.mp_access_token) {
    return new MercadoPagoConfig({ accessToken: sedeRow.mp_access_token });
  }

  return mpClient;
}

async function createMercadoPagoPreferenceInternal({
  titulo,
  precio,
  moneda,
  sedeNombre,
  sedeId,
  reservaData,
  extras = [],
  pricing,
}) {
  const client = await resolveMercadoPagoClient(sedeId);
  const paymentExtras = extras ?? reservaData?.extras ?? [];
  const paymentPricing = pricing ?? {
    base: reservaData?.precio_base ?? precio,
    fee: reservaData?.platform_fee ?? 0,
    extrasSubtotal: reservaData?.extras_subtotal ?? 0,
    total: precio,
  };
  const items = buildMercadoPagoItems({
    titulo,
    moneda,
    pricing: paymentPricing,
    extras: paymentExtras,
  });
  const externalReference = reservaData?.reserva_id
    ? String(reservaData.reserva_id)
    : (reservaData?.id ? String(reservaData.id) : '');
  const preference = new Preference(client);
  const response = await preference.create({
    body: {
      items,
      back_urls: {
        success: 'padbolmatch://pago-exitoso',
        failure: 'padbolmatch://pago-error',
        pending: 'padbolmatch://pago-exitoso',
      },
      auto_return: 'approved',
      external_reference: externalReference,
      statement_descriptor: sedeNombre || 'Padbol Match',
    },
  });

  return {
    init_point: response.init_point,
    preference_id: response.id,
  };
}

async function resolveSedeIdByNombre(sedeNombre) {
  if (!sedeNombre) return null;

  const { data: sedeRow } = await supabaseAdmin
    .from('sedes')
    .select('id')
    .eq('nombre', sedeNombre)
    .maybeSingle();

  return sedeRow?.id ?? null;
}

function normalizeReservaCancha(cancha) {
  if (cancha == null || cancha === '') return null;
  return String(cancha);
}

async function triggerPartidoCreatorPayment({ reserva, partido, sedeNombre, sedeId }) {
  let resolvedSedeNombre = sedeNombre ?? reserva.sede ?? null;
  let resolvedSedeId = sedeId ?? null;

  if (!resolvedSedeId && resolvedSedeNombre) {
    resolvedSedeId = await resolveSedeIdByNombre(resolvedSedeNombre);
  }

  if (!resolvedSedeNombre && resolvedSedeId) {
    const { data: sedeRow } = await supabaseAdmin
      .from('sedes')
      .select('nombre')
      .eq('id', resolvedSedeId)
      .maybeSingle();
    resolvedSedeNombre = sedeRow?.nombre ?? 'Sede';
  }

  const titulo = `Partido ${resolvedSedeNombre} - ${reserva.fecha} ${String(reserva.hora).slice(0, 5)}`;
  const reservaData = {
    action: 'confirmar_prereserva',
    reserva_id: reserva.id,
    partido_id: partido.id,
    sede_id: resolvedSedeId,
    sede: resolvedSedeNombre ?? reserva.sede,
    fecha: reserva.fecha,
    hora: reserva.hora,
    cancha: reserva.cancha,
    precio: reserva.precio,
    user_id: reserva.user_id,
  };

  const payment = await createMercadoPagoPreferenceInternal({
    titulo,
    precio: reserva.precio,
    moneda: reserva.moneda ?? 'ARS',
    sedeNombre: resolvedSedeNombre,
    sedeId: resolvedSedeId,
    reservaData,
    pricing: {
      base: reserva.precio,
      fee: 0,
      total: reserva.precio,
    },
  });

  await supabaseAdmin
    .from('reservas')
    .update({ pago_estado: 'pendiente_cobro' })
    .eq('id', reserva.id);

  await supabaseAdmin
    .from('partidos_abiertos')
    .update({ pago_url: payment.init_point ?? null })
    .eq('id', partido.id);

  return payment;
}

// Frontend URL for MP redirect callbacks
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://padbol-match.netlify.app';
if (!process.env.FRONTEND_URL) {
  console.warn(`⚠️  FRONTEND_URL no está configurado — usando fallback: ${FRONTEND_URL}`);
}

// Twilio (desde .env)
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── JWT + user_roles (mi-rol para panel /admin) ─────────────────────────────
const LEGACY_SUPER_ADMIN_EMAILS_API = [
  'padbolinternacional@gmail.com',
  'admin@padbol.com',
  'sm@padbol.com',
  'juanpablo@padbol.com',
];

async function authUserFromBearer(req) {
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.id) return null;
  return data.user;
}

async function fetchUserRoleRow(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  let q = await supabase
    .from('user_roles')
    .select('role, sede_id, nombre, pais, email, torneos_oficiales_habilitados')
    .eq('email', em)
    .maybeSingle();
  if (q.error && /colum|column/i.test(String(q.error.message || ''))) {
    q = await supabase
      .from('user_roles')
      .select('role, sede_id, nombre, pais, email')
      .eq('email', em)
      .maybeSingle();
  }
  if (q.error) return null;
  return q.data;
}

/** Rol autenticado: `user_id` (JWT) primero, luego email. Service role bypass RLS. */
async function fetchUserRoleRowForAuthUser(user) {
  if (!user?.email) return null;
  const uid = user.id ? String(user.id).trim() : '';
  if (uid) {
    let q = await supabase
      .from('user_roles')
      .select('role, sede_id, nombre, pais, email, torneos_oficiales_habilitados')
      .eq('user_id', uid)
      .maybeSingle();
    if (q.error && /colum|column/i.test(String(q.error.message || ''))) {
      q = await supabase
        .from('user_roles')
        .select('role, sede_id, nombre, pais, email')
        .eq('user_id', uid)
        .maybeSingle();
    }
    if (!q.error && q.data) return q.data;
  }
  return fetchUserRoleRow(user.email);
}

function buildMiRolJsonPayload(email, row) {
  const em = String(email || '').trim().toLowerCase();
  if (!row) {
    return {
      email: em,
      rol: null,
      role: null,
      sede_id: null,
      sedeId: null,
      nombre: null,
      pais: null,
      torneosOficialesHabilitados: false,
    };
  }
  const sedeIdRaw = row.sede_id;
  const sedeIdNum =
    sedeIdRaw != null && sedeIdRaw !== '' ? Number(sedeIdRaw) : null;
  const rol =
    String(row.role || '')
      .trim()
      .toLowerCase() || null;
  return {
    email: String(row.email || em).trim().toLowerCase(),
    rol,
    role: rol,
    sede_id: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
    sedeId: Number.isFinite(sedeIdNum) ? sedeIdNum : null,
    nombre: row.nombre ?? null,
    pais: row.pais ?? null,
    torneosOficialesHabilitados: Boolean(row.torneos_oficiales_habilitados),
  };
}

/** Rol en `user_roles` solo por `user_id` (JWT UUID). */
async function fetchUserRoleRowByJwtUserId(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return { data: null, error: null };
  let q = await supabaseAdmin
    .from('user_roles')
    .select('role, sede_id, nombre, pais, email, torneos_oficiales_habilitados, user_id')
    .eq('user_id', uid)
    .maybeSingle();
  if (q.error && /colum|column/i.test(String(q.error.message || ''))) {
    q = await supabaseAdmin
      .from('user_roles')
      .select('role, sede_id, nombre, pais, email, user_id')
      .eq('user_id', uid)
      .maybeSingle();
  }
  return q;
}

function buildDefaultJugadorMiRolPayload(email) {
  const em = String(email || '').trim().toLowerCase();
  return {
    email: em,
    rol: 'jugador',
    role: 'jugador',
    sede_id: null,
    sedeId: null,
    nombre: null,
    pais: null,
    torneosOficialesHabilitados: false,
  };
}

/** GET /api/auth/mi-rol y GET /api/usuarios/mi-rol — JWT; lectura `user_roles`. */
async function handleGetMiRol(req, res) {
  try {
    const authUser = await authUserFromBearer(req);
    if (!authUser?.id) return res.status(401).json({ error: 'No autorizado' });

    const userId = String(authUser.id).trim();
    const email = String(authUser.email || '').trim().toLowerCase();

    console.log('[mi-rol] lookup:', { userId });

    const { data: row, error: roleError } = await fetchUserRoleRowByJwtUserId(userId);

    console.log('[mi-rol] user_roles query result:', {
      userId,
      hasRow: Boolean(row),
      role: row?.role ?? null,
      sede_id: row?.sede_id ?? null,
      error: roleError?.message ?? null,
    });

    if (roleError || !row) {
      return res.json(buildDefaultJugadorMiRolPayload(email));
    }

    return res.json(buildMiRolJsonPayload(email, row));
  } catch (err) {
    console.error('❌ GET mi-rol:', err.message);
    return sendHttpError(res, err, { fallbackMessage: 'Error al obtener rol' });
  }
}

app.get('/api/auth/mi-rol', handleGetMiRol);
app.get('/api/usuarios/mi-rol', handleGetMiRol);

// WhatsApp confirmation helper
async function sendWhatsAppConfirmation(phone, { sede, fecha, hora, cancha, direccion }) {
  // Normalise number → E.164 without leading +, then prepend whatsapp:+
  const digits = String(phone).replace(/\D/g, '');
  const e164   = digits.startsWith('+') ? digits : `+${digits}`;
  const to     = `whatsapp:${e164}`;

  const body =
`✅ *Reserva confirmada en ${sede}*

📅 Fecha: ${fecha}
⏰ Hora: ${hora}
🎾 Cancha: ${cancha}${direccion ? `\n📍 ${direccion}` : ''}

⏱ Te esperamos 10 minutos antes.
❌ Podés cancelar hasta 24hs antes desde tu perfil en PADBOL MATCH.
💬 Ante cualquier consulta escribinos por WhatsApp.

*PADBOL MATCH*`;

  await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
  console.log(`✓ WhatsApp enviado — dest ${maskPhone(to) || 'ok'}`);
}

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, status: 401, error: 'Se requiere Authorization Bearer token' };
  }

  const token = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { user: null, status: 401, error: 'Token inválido o expirado' };
  }

  return { user: data.user, status: null, error: null };
}

function buildUserEmailOrIdFilters(user, { emailField = 'email', userIdFields = ['user_id'] } = {}) {
  const filters = [];

  if (user.email) {
    filters.push(`${emailField}.eq."${String(user.email).replace(/"/g, '\\"')}"`);
  }

  for (const field of userIdFields) {
    filters.push(`${field}.eq.${user.id}`);
  }

  return filters;
}

function mapMisInscripcionRow(row) {
  const torneo = row.torneos ?? {};

  return {
    torneo_id: row.torneo_id ?? torneo.id ?? null,
    id: torneo.id ?? row.torneo_id ?? null,
    nombre: torneo.nombre ?? null,
    sede_nombre: torneo.sedes?.nombre ?? null,
    sede_id: torneo.sede_id ?? null,
    fecha_inicio: torneo.fecha_inicio ?? null,
    fecha_fin: torneo.fecha_fin ?? null,
    formato: torneo.tipo_torneo ?? null,
    tipo_torneo: torneo.tipo_torneo ?? null,
    categoria: torneo.categoria ?? torneo.nivel_torneo ?? null,
    estado: torneo.estado ?? null,
    created_at: row.created_at ?? null,
  };
}

function getTodayArgentinaDate() {
  const nowAR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const year = nowAR.getFullYear();
  const month = String(nowAR.getMonth() + 1).padStart(2, '0');
  const day = String(nowAR.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseCheckinQrCode(qrCode) {
  try {
    const parsed = typeof qrCode === 'string' ? JSON.parse(qrCode) : qrCode;
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      reserva_id: parsed.reserva_id ?? parsed.reservaId ?? null,
      user_id: parsed.user_id ?? parsed.userId ?? null,
      sede_id: parsed.sede_id ?? parsed.sedeId ?? null,
      fecha: parsed.fecha ?? null,
      hora: parsed.hora ?? null,
      ts: parsed.ts ?? null,
    };
  } catch {
    return null;
  }
}

async function reservaMatchesSedeId(reserva, sedeId) {
  const { data: sedeRow } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre')
    .eq('id', sedeId)
    .maybeSingle();

  if (!sedeRow) return false;
  return reservaMatchesSede(reserva, { sedeId, sedeNombre: sedeRow.nombre });
}

async function getSedeNombre(reserva, sedeId) {
  if (reserva.sede_nombre) return reserva.sede_nombre;
  if (reserva.sede) return reserva.sede;

  const { data: sedeRow } = await supabaseAdmin
    .from('sedes')
    .select('nombre')
    .eq('id', sedeId)
    .maybeSingle();

  return sedeRow?.nombre ?? null;
}

function reservaBelongsToUser(reserva, user, qrUserId) {
  if (user.email && reserva.email && reserva.email === user.email) return true;
  if (reserva.user_id && reserva.user_id === user.id) return true;
  if (qrUserId && qrUserId === user.id) return true;
  return false;
}

// GET sedes
app.get('/api/sedes', async (req, res) => {
  try {
    console.log('📡 GET /api/sedes - Conectando a Supabase...');
    const { data, error } = await supabase
      .from('sedes')
      .select(SEDE_APP_SELECT);

    if (error) {
      console.error('❌ Error Supabase GET /api/sedes:', summarizeError(error));
      throw error;
    }

    console.log(`✓ GET /api/sedes — ${(data || []).length} sede(s)`);
    res.json(data || []);
  } catch (err) {
    console.error('❌ Error GET /api/sedes:', err.message);
    sendHttpError(res, err);
  }
});

mountSedesProfileRoutes(app, {
  supabase,
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountCanchasRoutes(app, { supabaseAdmin });
mountSurgeRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountResenasRoutes(app, {
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountReputacionRoutes(app, {
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountReservasDiagnosticoRoutes(app, {
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountReservasHoldCleanupRoutes(app, {
  supabaseAdmin,
  pgPool,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountSedeExtrasRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountScoreboardRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
  io,
});
initScoreboardSocket(io);
mountTorneoInteresRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountListaEsperaGeneralRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountLogrosPremiosRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountLigasPremiosRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});
mountNotificacionesRoutes(app, { supabaseAdmin, getAuthenticatedUser });
mountMercadoPagoWebhookRoutes(app, {
  pgPool,
  supabase,
  sendWhatsAppConfirmation,
  defaultMpToken: process.env.MP_ACCESS_TOKEN || '',
});
mountStripeWebhookRoutes(app, {
  pgPool,
  supabase,
  stripeClient,
  sendWhatsAppConfirmation,
});
mountRankingsLeaderboardRoutes(app, { supabaseAdmin, getAuthenticatedUser });
mountArenaRoutes(app, { supabaseAdmin, getAuthenticatedUser });

// GET /api/sedes/:id — datos públicos de la sede (reserva, horarios, precios; sin JWT)
app.get('/api/sedes/:id', async (req, res) => {
  try {
    const sedeId = parseInt(req.params.id, 10);
    if (Number.isNaN(sedeId)) {
      return res.status(400).json({ error: 'ID de sede inválido' });
    }

    const { data, error } = await supabaseAdmin
      .from('sedes')
      .select(SEDE_APP_SELECT)
      .eq('id', sedeId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Sede no encontrada' });
    }

    res.json(enrichSedeWithHeroPhoto(data));
  } catch (err) {
    console.error('❌ Error GET /api/sedes/:id:', err.message);
    sendHttpError(res, err);
  }
});

// GET /api/sedes/:id/extras — extras públicos para checkout (sin JWT)
app.get('/api/sedes/:id/extras', async (req, res) => {
  try {
    const sid = parseInt(String(req.params.id || '').trim(), 10);
    if (!Number.isFinite(sid) || sid <= 0) {
      return res.status(400).json({ error: 'sede_id inválido' });
    }

    const { data, error } = await supabaseAdmin
      .from('sede_extras')
      .select('id,nombre,descripcion,precio,precio_moneda,imagen_url,stock')
      .eq('sede_id', sid)
      .eq('activo', true)
      .eq('aprobado_super', true)
      .order('nombre', { ascending: true });
    if (error) throw error;

    const extras = (data || [])
      .filter((row) => {
        if (row.stock == null) return true;
        const s = parseInt(String(row.stock), 10);
        return Number.isFinite(s) && s > 0;
      })
      .map((row) => ({
        ...row,
        precio: row.precio != null ? Math.round(Number(row.precio)) : 0,
      }));

    res.json({ extras });
  } catch (err) {
    console.error('❌ GET /api/sedes/:id/extras:', {
      sedeId: req.params.id,
      message: err?.message || String(err),
      code: err?.code,
      details: err?.details,
      stack: err?.stack,
    });
    sendHttpError(res, err);
  }
});

// GET disponibilidad — slots con reservas + partidos_abiertos (cancha + hora)
app.get('/api/disponibilidad', async (req, res) => {
  try {
    const sedeId = parsePositiveInt(req.query.sede_id);
    const fecha = req.query.fecha;
    const duracionMinutos = parsePositiveInt(req.query.duracion) ?? 90;
    const expandCourts = req.query.expand_courts === 'true' || req.query.expand_courts === '1';

    if (sedeId == null || !fecha) {
      return res.status(400).json({ error: 'sede_id y fecha son requeridos' });
    }

    const slots = await buildDisponibilidadSlots(supabaseAdmin, {
      sedeId,
      fecha,
      duracionMinutos,
      expandCourts,
    });

    if (!slots) {
      return res.status(404).json({ error: 'Sede no encontrada' });
    }

    res.json({ slots });
  } catch (err) {
    console.error('❌ Error GET /api/disponibilidad:', err.message);
    sendHttpError(res, err);
  }
});

// GET bloqueos (reservas + partidos) para fallback del cliente
app.get('/api/disponibilidad/bloqueos', async (req, res) => {
  try {
    const sedeId = parsePositiveInt(req.query.sede_id);
    const fecha = req.query.fecha;

    if (sedeId == null || !fecha) {
      return res.status(400).json({ error: 'sede_id y fecha son requeridos' });
    }

    const { data: sede, error: sedeErr } = await supabaseAdmin
      .from('sedes')
      .select('id, nombre')
      .eq('id', sedeId)
      .maybeSingle();

    if (sedeErr) throw sedeErr;
    if (!sede) {
      return res.status(404).json({ error: 'Sede no encontrada' });
    }

    const occupancy = await fetchDisponibilidadOccupancy(supabaseAdmin, {
      sedeId,
      sedeNombre: sede.nombre,
      fecha,
    });

    res.json(occupancy);
  } catch (err) {
    console.error('❌ Error GET /api/disponibilidad/bloqueos:', err.message);
    sendHttpError(res, err);
  }
});

// GET disponibilidad — reservas bloqueantes por sede (nombre) + fecha
app.get('/api/disponibilidad/:sede/:fecha', async (req, res) => {
  try {
    const { sede, fecha } = req.params;
    const selectCols = 'id, hora, hora_inicio, hora_fin, cancha, cancha_id, estado, created_at, sede, sede_id, duracion_minutos';

    const { data: sedeRow } = await supabaseAdmin
      .from('sedes')
      .select('id')
      .eq('nombre', sede)
      .maybeSingle();

    const queries = [
      supabase.from('reservas').select(selectCols).eq('sede', sede).eq('fecha', fecha),
    ];
    if (sedeRow?.id != null) {
      queries.push(
        supabase.from('reservas').select(selectCols).eq('sede_id', sedeRow.id).eq('fecha', fecha),
      );
    }

    const results = await Promise.all(queries);
    for (const r of results) {
      if (r.error) throw r.error;
    }

    const merged = new Map();
    for (const row of results.flatMap((r) => r.data ?? [])) {
      if (row?.id != null) merged.set(String(row.id), row);
    }

    res.json(filterBlockingReservas([...merged.values()]));
  } catch (err) {
    sendHttpError(res, err);
  }
});

// POST reserva
app.post('/api/reservas', reservasWriteRateLimit, async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
    }

    const {
      sede,
      sede_id: sedeIdBody,
      fecha,
      hora,
      cancha,
      cancha_id,
      cancha_nombre,
      canchaSeleccionada,
      nombre,
      email,
      whatsapp,
      telefono,
      nivel,
      nivel_partido,
      precio,
      duracion_minutos,
      modo_partido: modoPartidoRaw,
    } = req.body;

    const modoPartido = modoPartidoRaw === true || modoPartidoRaw === 'true';
    const authUser = user;

    if (modoPartido) {
      logPartidoCanchaBody(req.body, 'POST /api/reservas modo_partido');
    }

    const contactEmail = email ?? authUser.email;
    const contactWhatsapp = whatsapp ?? telefono ?? '';
    const contactNombre = nombre
      ?? authUser?.user_metadata?.full_name
      ?? authUser?.user_metadata?.name
      ?? authUser?.email
      ?? 'Jugador';

    if (!fecha || !hora || !contactEmail) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    if (!sede && !sedeIdBody) {
      return res.status(400).json({ error: 'Falta sede o sede_id' });
    }

    let sedeNombre = sede;
    let sedeId = parsePositiveInt(sedeIdBody);

    if (sedeId != null && !sedeNombre) {
      const { data: sedeRow } = await supabaseAdmin
        .from('sedes')
        .select('nombre')
        .eq('id', sedeId)
        .maybeSingle();
      sedeNombre = sedeRow?.nombre ?? null;
    }

    if (sedeId == null && sedeNombre) {
      const { data: sedeRow } = await supabaseAdmin
        .from('sedes')
        .select('id')
        .eq('nombre', sedeNombre)
        .maybeSingle();
      sedeId = parsePositiveInt(sedeRow?.id);
    }

    if (!sedeNombre) {
      return res.status(400).json({ error: 'Sede no encontrada' });
    }

    const bookingUserId = authUser.id;
    if (bookingUserId && pgPool) {
      try {
        const susp = await assertJugadorNoSuspendidoPg(pgPool, bookingUserId);
        if (susp.suspendido) {
          const hasta = susp.suspendido_hasta
            ? new Date(susp.suspendido_hasta).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
            : null;
          return res.status(403).json({
            error: hasta
              ? `Tenés una suspensión activa por cancelaciones tardías. Podrás reservar nuevamente después del ${hasta}.`
              : 'Tenés una suspensión activa por cancelaciones tardías y no podés crear reservas en este momento.',
            suspendido: true,
            suspendido_hasta: susp.suspendido_hasta ?? null,
          });
        }
      } catch (suspErr) {
        console.warn('⚠️ verificación suspensión reserva:', suspErr.message);
      }
    }

    const canchaStorage = resolveReservaCanchaStorageText(req.body);
    const partidoCanchaNombre = resolvePartidoCanchaNombre(req.body);
    const durationMinutes = parsePositiveInt(duracion_minutos) ?? 90;

    const blocked = await isCourtBlocked(supabaseAdmin, {
      sedeNombre,
      sedeId,
      fecha,
      hora,
      cancha: canchaStorage,
      duracionMinutos: durationMinutes,
    });

    if (blocked) {
      return res.status(409).json({ error: 'Este horario ya está reservado' });
    }

    const insertRow = buildReservaInsertRow({
      sedeNombre,
      sedeId,
      fecha,
      hora,
      hora_inicio: req.body.hora_inicio,
      hora_fin: req.body.hora_fin,
      canchaText: canchaStorage,
      cancha_id: cancha_id ?? req.body.cancha_id,
      nombre: contactNombre,
      email: contactEmail,
      telefono: contactWhatsapp,
      whatsapp: contactWhatsapp,
      nivel: nivel_partido ?? nivel ?? 'Principiante',
      precio,
      estado: modoPartido ? 'prereserva' : 'pendiente',
      pago_estado: 'pendiente',
      duracion_minutos: durationMinutes,
      user_id: authUser.id,
    });

    console.log('[POST reserva] insert', {
      sede_id: sedeId,
      fecha,
      estado: modoPartido ? 'prereserva' : 'pendiente',
    });

    const { data: reservaRows, error: insertErr } = await supabaseAdmin
      .from('reservas')
      .insert([insertRow])
      .select(RESERVA_OWNER_SELECT);

    if (insertErr) {
      if (isReservaSlotUniqueViolation(insertErr)) {
        return res.status(409).json({ error: 'Este horario ya está reservado' });
      }
      throw insertErr;
    }

    const reserva = reservaRows?.[0];
    if (!reserva) {
      throw new Error('No se pudo crear la reserva');
    }

    console.log(`✓ Reserva creada id=${reserva.id}`);

    let partidoId = null;
    let deadlineCancel = null;
    if (modoPartido) {
      if (sedeId == null) {
        return res.status(400).json({ error: 'sede_id requerido para partido abierto' });
      }

      const nivelPartido = nivel_partido ?? nivel ?? 'Intermedio';
      deadlineCancel = computePartidoDeadlineCancel(fecha, hora);

      const partidoInsert = buildPartidoAbiertoInsertRow({
        sedeRow: { id: sedeId, nombre: sedeNombre },
        body: req.body,
        reservaId: reserva.id,
        canchaNombre: partidoCanchaNombre,
        capitanFields: await buildCapitanFields(supabaseAdmin, authUser, { email: contactEmail }),
        fecha,
        hora,
        nivel: nivelPartido,
        estado: 'abierto',
        deadlineCancel,
        duracionMinutos: durationMinutes,
      });
      console.log('[DEBUG partidos_abiertos INSERT]', {
        reserva_id: reserva.id,
        sede_id: sedeId,
        estado: 'abierto',
      });

      const { data: partido, error: partidoErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .insert([partidoInsert])
        .select('*')
        .single();

      if (partidoErr) throw partidoErr;

      const { error: hostJoinErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .insert([{
          partido_id: partido.id,
          user_id: authUser.id,
          email: authUser.email ?? contactEmail,
        }]);

      if (hostJoinErr) throw hostJoinErr;

      partidoId = partido.id;
      console.log(`✓ Partido prereserva ${partidoId} creado (sin pago) — reserva ${reserva.id}`);
    }

    const mappedReserva = mapMisReservaRow({ ...reserva, sedes: { nombre: sedeNombre } });

    if (modoPartido && partidoId) {
      return res.status(201).json({
        partido_id: partidoId,
        partido_link: `padbolmatch://partido/${partidoId}`,
        deadline_cancel: deadlineCancel,
        reserva_id: reserva.id,
      });
    }

    res.json([mappedReserva]);
  } catch (err) {
    if (Number(err?.status) === 409 || isReservaSlotUniqueViolation(err)) {
      return res.status(409).json({ error: 'Este horario ya está reservado' });
    }
    console.error('❌ Error POST reserva:', err.message);
    sendHttpError(res, err);
  }
});

// POST /api/reservas/:id/confirmar — deshabilitado: confirmación solo vía pago MP verificado
app.post('/api/reservas/:id/confirmar', async (req, res) => {
  return res.status(410).json({
    error: 'Este endpoint ya no confirma reservas. La confirmación ocurre automáticamente tras un pago aprobado en Mercado Pago.',
    code: 'CONFIRMAR_DISABLED_USE_MP_WEBHOOK',
  });
});

mountReservaQrRoutes(app, {
  pgPool,
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});

// GET reservas — JWT; super_admin todas, admin_club su sede, jugador solo las propias
app.get('/api/reservas', async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
    if (!user) return;

    const role = await resolveAuthRoleForUser(user, {
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
    });

    const ownerFilters = buildUserEmailOrIdFilters(user, { userIdFields: ['user_id'] });
    const ownerFilter = ownerFilters.length > 0 ? ownerFilters.join(',') : null;
    const scope = await resolveReservasListScope(role, ownerFilter, supabaseAdmin);

    if (scope.kind === 'forbidden') {
      return res.status(403).json({ error: 'No tenés permiso para consultar reservas' });
    }

    const isAdmin = scope.kind === 'all' || scope.kind === 'sede';
    const selectCols = isAdmin ? RESERVA_ADMIN_SELECT : RESERVA_OWNER_SELECT;

    let query = supabaseAdmin
      .from('reservas')
      .select(selectCols)
      .order('created_at', { ascending: false });

    query = applyReservasListScopeToQuery(query, scope);

    const { data, error } = await query;
    if (error) throw error;
    res.json((data || []).map((row) => mapReservaListDto(row, { isAdmin })));
  } catch (err) {
    sendHttpError(res, err);
  }
});

// GET /api/reservas/mis-reservas — authenticated user's reservations (JWT required)
app.get('/api/reservas/mis-reservas', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const filters = buildUserEmailOrIdFilters(user, {
      userIdFields: ['user_id'],
    });

    const { data, error } = await supabaseAdmin
      .from('reservas')
      .select(RESERVA_OWNER_SELECT)
      .or(filters.join(','))
      .order('fecha', { ascending: false })
      .order('hora', { ascending: false });

    if (error) throw error;

    res.json((data || []).map(mapMisReservaRow));
  } catch (err) {
    console.error('❌ Error GET /api/reservas/mis-reservas:', err.message);
    sendHttpError(res, err);
  }
});

// GET ingresos — JWT admin (super_admin global, admin_club su sede)
app.get('/api/ingresos', async (req, res) => {
  try {
    const auth = await requireAdminUser(req, res, {
      getAuthenticatedUser,
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
    });
    if (!auth) return;

    const scope = await resolveIngresosListScope(auth.role, supabaseAdmin);
    if (scope.kind === 'forbidden') {
      return res.status(403).json({ error: 'No tenés permiso para esta operación' });
    }

    let query = supabaseAdmin
      .from('reservas')
      .select('precio')
      .eq('estado', 'confirmada');

    query = applyReservasListScopeToQuery(query, scope);

    const { data, error } = await query;

    if (error) throw error;

    const total = (data ?? []).reduce((sum, r) => sum + (r.precio || 0), 0);
    res.json({ total, reservas: data?.length ?? 0 });
  } catch (err) {
    sendHttpError(res, err);
  }
});

// PUT reserva — JWT; jugador solo nombre; admin dentro de su alcance
app.put('/api/reservas/:id', reservasWriteRateLimit, async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
    if (!user) return;

    const { id } = req.params;
    const { data: reserva, error: fetchErr } = await supabaseAdmin
      .from('reservas')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!reserva) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const access = await resolveReservaAccess(user, reserva, {
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
      supabaseAdmin,
      pgPool,
    });

    if (!access) {
      return res.status(403).json({ error: 'No tenés permiso para esta reserva' });
    }

    const updates = access === 'admin'
      ? buildAdminReservaPutUpdates(req.body, { normalizeReservaCancha })
      : buildNormalUserReservaPutUpdates(req.body);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    const { data, error } = await supabaseAdmin
      .from('reservas')
      .update(updates)
      .eq('id', id)
      .select(access === 'admin' ? RESERVA_ADMIN_SELECT : RESERVA_OWNER_SELECT);

    if (error) throw error;
    const mapped = (data || []).map((row) => mapReservaDetailDto(row, { isAdmin: access === 'admin' }));
    res.json(mapped);
  } catch (err) {
    const st = err.status || 500;
    if (st >= 400 && st < 500) {
      return res.status(st).json({ error: sanitizeClientErrorMessage(err, st) });
    }
    sendHttpError(res, err);
  }
});

// DELETE reserva — JWT; jugador usa cancelar-reserva; admin cancela sin borrar
app.delete('/api/reservas/:id', reservasWriteRateLimit, async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
    if (!user) return;

    const { id } = req.params;
    const { data: reserva, error: fetchErr } = await supabaseAdmin
      .from('reservas')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!reserva) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const access = await resolveReservaAccess(user, reserva, {
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
      supabaseAdmin,
      pgPool,
    });

    if (!access) {
      return res.status(403).json({ error: 'No tenés permiso para esta reserva' });
    }

    if (access === 'owner') {
      return res.status(405).json({
        error: 'Use POST /api/cancelar-reserva para cancelar tu reserva',
        use: '/api/cancelar-reserva',
      });
    }

    if (reserva.estado === 'cancelada') {
      return res.status(409).json({ error: 'La reserva ya está cancelada' });
    }

    const { error } = await supabaseAdmin
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', id);

    if (error) throw error;
    res.json({ mensaje: 'Reserva cancelada' });
  } catch (err) {
    const st = err.status || 500;
    if (st >= 400 && st < 500) {
      return res.status(st).json({ error: sanitizeClientErrorMessage(err, st) });
    }
    sendHttpError(res, err);
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

// ===== TORNEOS (legacy admin writes — JWT + rol sede) =====
const LEGACY_TORNEO_ADMIN_DEPS = {
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
};

function parseTorneoRouteId(raw) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchTorneoSedeIdById(torneoId) {
  const id = parseTorneoRouteId(torneoId);
  if (id == null) return null;
  const { data, error } = await supabaseAdmin
    .from('torneos')
    .select('sede_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  const sid = data?.sede_id;
  return sid != null && sid !== '' ? Number(sid) : null;
}

async function requireTorneoAdminForSede(req, res, torneoSedeId) {
  const auth = await requireAdminUser(req, res, LEGACY_TORNEO_ADMIN_DEPS);
  if (!auth) return null;

  if (auth.role.rol === 'super_admin') {
    return auth;
  }

  if (auth.role.rol === 'admin_club') {
    const requiredSedeId = torneoSedeId != null ? Number(torneoSedeId) : null;
    if (requiredSedeId == null || auth.role.sede_id !== requiredSedeId) {
      res.status(403).json({ error: 'No tenés permiso para operar torneos de otra sede' });
      return null;
    }
    return auth;
  }

  res.status(403).json({ error: 'No tenés permiso para esta operación' });
  return null;
}

async function requireTorneoAdminByTorneoId(req, res, torneoId) {
  const sedeId = await fetchTorneoSedeIdById(torneoId);
  return requireTorneoAdminForSede(req, res, sedeId);
}

mountTorneosFinalizadosRoutes(app, { pgPool });
mountPushRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
});

app.post('/api/torneos', async (req, res) => {
  try {
    const { nombre, sede_id, nivel_torneo, tipo_torneo, fecha_inicio, fecha_fin, cantidad_equipos, es_multisede, created_by } = req.body;
    const targetSedeId = sede_id != null && sede_id !== '' ? Number(sede_id) : null;
    const auth = await requireTorneoAdminForSede(req, res, targetSedeId);
    if (!auth) return;

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
    sendHttpError(res, err);
  }
});

app.get('/api/torneos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('torneos')
      .select(TORNEO_PUBLIC_SELECT)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json((data || []).map(mapTorneoPublicRow));
  } catch (err) {
    sendHttpError(res, err);
  }
});

// GET /api/torneos/mis-inscripciones — authenticated user's tournament enrollments (JWT required)
app.get('/api/torneos/mis-inscripciones', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const filters = buildUserEmailOrIdFilters(user, {
      userIdFields: ['user_id'],
    });

    const { data, error } = await supabaseAdmin
      .from('jugadores_torneo')
      .select(`
        torneo_id,
        created_at,
        torneos (
          id,
          nombre,
          sede_id,
          fecha_inicio,
          fecha_fin,
          tipo_torneo,
          categoria,
          nivel_torneo,
          estado,
          sedes ( nombre )
        )
      `)
      .or(filters.join(','))
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json((data || []).map(mapMisInscripcionRow));
  } catch (err) {
    console.error('❌ Error GET /api/torneos/mis-inscripciones:', err.message);
    sendHttpError(res, err);
  }
});

app.get('/api/torneos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('torneos')
      .select(TORNEO_PUBLIC_SELECT)
      .eq('id', id)
      .single();

    if (error) throw error;
    res.json(mapTorneoPublicRow(data));
  } catch (err) {
    sendHttpError(res, err);
  }
});

// POST /api/torneos/confirmar-inscripcion — deshabilitado: confirmación solo vía pago verificado
app.post('/api/torneos/confirmar-inscripcion', async (req, res) => {
  return res.status(410).json({
    error: 'Este endpoint ya no confirma inscripciones. La confirmación debe hacerse tras un pago verificado.',
    code: 'TORNEO_CONFIRMAR_DISABLED',
  });
});

app.put('/api/torneos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, id);
    if (!auth) return;

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
    sendHttpError(res, err);
  }
});

app.delete('/api/torneos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, id);
    if (!auth) return;

    const { error } = await supabase
      .from('torneos')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ mensaje: 'Torneo eliminado' });
  } catch (err) {
    sendHttpError(res, err);
  }
});

// POST /api/torneos/:id/generar-partidos
// Reads all equipos for the torneo, generates matches based on tipo_torneo,
// saves them to partidos, and sets the torneo estado to 'en_curso'.
// Requires 'ronda' (int, nullable) and 'grupo' (text, nullable) columns on partidos table.
app.post('/api/torneos/:id/generar-partidos', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, id);
    if (!auth) return;

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

    const { count: existingPartidosCount, error: errExistingPartidos } = await supabase
      .from('partidos')
      .select('id', { count: 'exact', head: true })
      .eq('torneo_id', parseInt(id, 10));
    if (errExistingPartidos) throw errExistingPartidos;
    if (existingPartidosCount > 0) {
      return res.status(400).json({ error: 'El torneo ya tiene partidos generados' });
    }

    let partidosData;
    switch (torneo.tipo_torneo) {
      case 'round_robin':
        partidosData = generarRoundRobin(equipos, id, torneo.sede_id);
        break;
      case 'knockout':
        try {
          assertKnockoutBracketTeamCount(equipos.length);
        } catch (err) {
          if (err.status === 400) {
            return res.status(400).json({ error: err.message });
          }
          throw err;
        }
        partidosData = buildKnockoutBracketMatches({
          equipos,
          torneoId: id,
          sedeId: torneo.sede_id,
        });
        break;
      case 'grupos_knockout':
        partidosData = generarGruposKnockout(equipos, id, torneo.sede_id);
        break;
      default:
        partidosData = generarRoundRobin(equipos, id, torneo.sede_id);
    }

    const { data: partidosInsertados, error: errPartidos } = await supabase
      .from('partidos')
      .insert(partidosData)
      .select();
    if (errPartidos) throw errPartidos;

    let partidos = partidosInsertados;
    if (torneo.tipo_torneo === 'knockout') {
      const linkUpdates = linkBracketMatches(partidosInsertados);
      for (const patch of linkUpdates) {
        const { id: partidoId, ...fields } = patch;
        const { error: errLink } = await supabase
          .from('partidos')
          .update(fields)
          .eq('id', partidoId);
        if (errLink) throw errLink;
      }
      partidos = mergeBracketLinks(partidosInsertados, linkUpdates);
    }

    await supabase.from('torneos').update({ estado: 'en_curso' }).eq('id', id);

    notifyTorneoSorteoPublicado(supabaseAdmin, parseInt(id, 10)).catch((err) =>
      console.warn('⚠️ Push sorteo torneo:', err.message),
    );

    console.log(`✅ ${partidos.length} partidos generados para torneo ${id} (${torneo.tipo_torneo})`);
    res.json({ partidos, total: partidos.length, formato: torneo.tipo_torneo });
  } catch (err) {
    console.error('❌ Error generar-partidos:', err.message);
    sendHttpError(res, err);
  }
});

// POST /api/torneos/:id/generar-scoreboards
app.post('/api/torneos/:id/generar-scoreboards', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, id);
    if (!auth) return;

    const result = await generarScoreboardsForTorneo(supabaseAdmin, id, req.body ?? {});
    console.log(
      `✅ Scoreboards torneo ${id}: created=${result.created}, skipped=${result.skipped}, total=${result.items.length}`,
    );
    res.json(result);
  } catch (err) {
    console.error('❌ Error generar-scoreboards:', err.message);
    sendHttpError(res, err);
  }
});

// POST /api/torneos/:id/generar-knockout-desde-grupos
// Para torneos grupos_knockout: al terminar la fase de grupos, genera la llave
// eliminatoria con los clasificados (siembra cruzada). No recalcula finalización.
app.post('/api/torneos/:id/generar-knockout-desde-grupos', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, id);
    if (!auth) return;

    const result = await generarKnockoutDesdeGrupos(supabaseAdmin, id);

    notifyTorneoSorteoPublicado(supabaseAdmin, parseInt(id, 10)).catch((err) =>
      console.warn('⚠️ Push sorteo torneo (grupos→knockout):', err.message),
    );

    console.log(`✅ Llave grupos→knockout torneo ${id}: ${result.total} partidos`);
    res.json(result);
  } catch (err) {
    const status = Number(err?.status ?? 500);
    if (status >= 500) {
      console.error('❌ Error generar-knockout-desde-grupos:', err.message);
    } else {
      console.warn(`⚠️ generar-knockout-desde-grupos ${req.params.id}: ${err.code ?? err.message}`);
    }
    sendHttpError(res, err);
  }
});

// ===== RANKINGS =====
function mapLegacyRankingPublicRow(entry) {
  return {
    nombre: entry.nombre ?? null,
    apellido: entry.apellido ?? '',
    pais: entry.pais ?? null,
    foto_url: entry.foto_url ?? null,
    nivel: entry.nivel ?? null,
    sede_id: entry.sede_id ?? null,
    equipo_nombre: entry.equipo_nombre ?? null,
    puntos_total: entry.puntos_total ?? 0,
    torneos_count: entry.torneos_count ?? 0,
  };
}

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
        .select('email, nombre, apellido, pais, foto_url, sede_id, nivel')
        .in('email', emails);

      (perfiles || []).forEach(perfil => {
        const entry = playerMap[perfil.email];
        if (!entry) return;
        entry.foto_url = perfil.foto_url || null;
        entry.pais     = perfil.pais     || null;
        entry.nivel    = perfil.nivel    || null;
        entry.sede_id  = perfil.sede_id  || null;
        entry.nombre   = formatTournamentPlayerName(perfil) || entry.nombre;
        entry.apellido = perfil.apellido ?? '';
      });
    }

    // 6. Filter by categoria
    let result = Object.values(playerMap);
    if (categoria) result = result.filter(p => p.nivel === categoria);

    // 7. Sort by puntos_total desc, then torneos_count desc
    result.sort((a, b) => b.puntos_total - a.puntos_total || b.torneos_count - a.torneos_count);

    res.json(result.map(mapLegacyRankingPublicRow));
  } catch (err) {
    console.error('❌ Error GET /api/rankings:', err.message);
    sendHttpError(res, err);
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

function calcPadcoinsPorPosicion(posicion) {
  const p = Number(posicion);
  if (!Number.isFinite(p) || p < 1) return 10;
  if (p === 1) return 100;
  if (p === 2) return 70;
  if (p === 3) return 50;
  if (p >= 4 && p <= 10) return 20;
  return 10;
}

app.post('/api/torneos/:id/finalizar', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = await requireTorneoAdminByTorneoId(req, res, id);
    if (!auth) return;

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

    const { rankingRows, source } = buildFinalRankingForTorneo({
      equipos: equipos || [],
      partidos: partidos || [],
      tipoTorneo: torneo.tipo_torneo,
    });

    if (!rankingRows.length) {
      return res.status(400).json({
        error: 'No se pudo calcular el ranking final del torneo.',
        code: 'TORNEO_RANKING_EMPTY',
        tipo_torneo: torneo.tipo_torneo ?? null,
      });
    }

    const base = BASE_PUNTOS[torneo.nivel_torneo] ?? 10;
    const puntosData = buildTablaPuntosFromRankingRows(rankingRows, {
      torneoId: parseInt(id, 10),
      basePoints: base,
      posicionMult: POSICION_MULT,
    });

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

    const jugadorUserIds = collectUserIdsFromEquipos(equipos);
    await Promise.all(
      jugadorUserIds.map((userId) =>
        actualizarRango(supabaseAdmin, userId).catch((err) =>
          console.warn(`⚠️ actualizarRango torneo ${id} user ${userId}:`, err.message),
        ),
      ),
    );

    // TODO: Auto-set jugadores_perfil.companero_habitual_id to the tournament doubles partner
    // when a match is completed (use the partner from that match for each player).

    console.log(`🏆 Torneo ${id} finalizado (${source}). ${puntosData.length} equipos clasificados.`);
    res.json({
      torneo: torneoFinal,
      clasificacion: puntosData,
    });
  } catch (err) {
    console.error('❌ Error finalizar torneo:', err.message);
    sendHttpError(res, err);
  }
});

app.get('/api/torneos/:id/tabla', async (req, res) => {
  try {
    const torneoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(torneoId)) {
      return res.status(400).json({ ok: false, error: 'ID de torneo inválido' });
    }

    const scopeRaw = String(req.query.scope ?? 'all').trim().toLowerCase();
    if (!['all', 'general', 'grupos'].includes(scopeRaw)) {
      return res.status(400).json({ ok: false, error: 'scope inválido' });
    }

    const grupoFilter = req.query.grupo != null && String(req.query.grupo).trim() !== ''
      ? String(req.query.grupo).trim().toUpperCase()
      : null;

    const { data: torneo, error: errTorneo } = await supabaseAdmin
      .from('torneos')
      .select('id, tipo_torneo')
      .eq('id', torneoId)
      .single();

    if (errTorneo) {
      if (errTorneo.code === 'PGRST116') {
        return res.status(404).json({ ok: false, error: 'Torneo no encontrado' });
      }
      throw errTorneo;
    }

    const [{ data: equipos, error: errEq }, { data: partidos, error: errPart }] = await Promise.all([
      supabaseAdmin.from('equipos').select('id, nombre').eq('torneo_id', torneoId),
      supabaseAdmin.from('partidos').select('*').eq('torneo_id', torneoId),
    ]);
    if (errEq) throw errEq;
    if (errPart) throw errPart;

    const clasificacion = buildClasificacion({
      equipos: equipos || [],
      partidos: partidos || [],
      tipoTorneo: torneo.tipo_torneo,
      scope: scopeRaw,
      grupo: grupoFilter,
    });

    const actualizadoAt = new Date().toISOString();
    const publicResponse = buildTablaLivePublicResponse({
      torneoId,
      tipoTorneo: torneo.tipo_torneo ?? null,
      clasificacion,
      actualizadoAt,
    });

    return res.json({
      ...publicResponse,
      scope: scopeRaw,
      calculated_at: actualizadoAt,
    });
  } catch (err) {
    console.error('❌ GET /api/torneos/:id/tabla:', err.message);
    sendHttpError(res, err);
  }
});

app.get('/api/torneos/:id/tabla-puntos', async (req, res) => {
  try {
    const torneoId = Number(req.params.id);

    if (!Number.isFinite(torneoId)) {
      return res.status(400).json({ error: 'ID de torneo inválido' });
    }

    const { data, error } = await supabaseAdmin
      .from('tabla_puntos')
      .select('torneo_id, equipo_id, posicion, puntos')
      .eq('torneo_id', torneoId)
      .order('posicion', { ascending: true });

    if (error) throw error;

    const enriched = (data || []).map((row) => ({
      ...row,
      padcoins: calcPadcoinsPorPosicion(row.posicion),
      rankingPoints: Number(row.puntos) || 0,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('❌ Error obteniendo tabla de puntos:', err.message);
    res.status(500).json({ error: 'Error obteniendo tabla de puntos' });
  }
});

// ===== JUGADORES =====
app.post('/api/jugadores', (req, res) => legacyWriteDisabled(res, 'POST /api/jugadores'));

app.get('/api/jugadores', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('jugadores')
      .select(JUGADOR_PUBLIC_SELECT)
      .eq('estado', 'activo')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json((data || []).map(mapJugadorPublicRow));
  } catch (err) {
    sendHttpError(res, err);
  }
});

// GET perfil público: /api/jugador/perfil-publico/:userId (ver mountJugadorPerfilPublicoRoutes al final)

app.get('/api/jugadores/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('jugadores')
      .select(JUGADOR_PUBLIC_SELECT)
      .eq('id', id)
      .single();

    if (error) throw error;
    res.json(mapJugadorPublicRow(data));
  } catch (err) {
    sendHttpError(res, err);
  }
});

app.put('/api/jugadores/:id', (req, res) => legacyWriteDisabled(res, 'PUT /api/jugadores/:id'));

// ===== JUGADORES TORNEO =====
app.post('/api/torneos/:torneo_id/jugadores', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
    }

    const { torneo_id } = req.params;
    const { nombre, email, user_id, numero_camiseta, es_capitan, pais } = req.body;

    const bodyUserId = user_id != null && String(user_id).trim() !== ''
      ? String(user_id).trim()
      : null;
    const bodyEmail = email != null && String(email).trim() !== ''
      ? String(email).trim().toLowerCase()
      : null;
    const authEmail = String(user.email || '').trim().toLowerCase();

    if (bodyUserId && bodyUserId !== user.id) {
      return res.status(403).json({ error: 'No podés inscribir a otro usuario' });
    }
    if (bodyEmail && authEmail && bodyEmail !== authEmail) {
      return res.status(403).json({ error: 'No podés inscribir con otro email' });
    }

    const resolvedUserId = bodyUserId ?? user.id;
    const resolvedEmail = bodyEmail ?? authEmail ?? null;
    const resolvedNombre = nombre
      ?? user.user_metadata?.full_name
      ?? user.user_metadata?.name
      ?? resolvedEmail
      ?? 'Jugador';

    const { data, error } = await supabase
      .from('jugadores_torneo')
      .insert([{
        torneo_id: parseInt(torneo_id),
        nombre: resolvedNombre,
        email: resolvedEmail,
        user_id: resolvedUserId,
        numero_camiseta,
        es_capitan,
        pais: pais || null,
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    sendHttpError(res, err);
  }
});

app.get('/api/torneos/:torneo_id/jugadores', async (req, res) => {
  try {
    const { torneo_id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('jugadores_torneo')
      .select(JUGADOR_TORNEO_PUBLIC_SELECT)
      .eq('torneo_id', parseInt(torneo_id));

    if (error) throw error;
    res.json((data || []).map(mapJugadorTorneoPublicRow));
  } catch (err) {
    sendHttpError(res, err);
  }
});

app.delete('/api/jugadores_torneo/:id', (req, res) => legacyWriteDisabled(res, 'DELETE /api/jugadores_torneo/:id'));

// ===== EQUIPOS =====
app.post('/api/torneos/:torneo_id/equipos', (req, res) => legacyWriteDisabled(res, 'POST /api/torneos/:torneo_id/equipos'));

app.get('/api/torneos/:torneo_id/equipos', async (req, res) => {
  try {
    const { torneo_id } = req.params;
    const tid = parseInt(torneo_id, 10);

    const [
      { data: equipos, error: errE },
      { data: grupoPartidos },
      puntosResult,
    ] = await Promise.all([
      supabaseAdmin
        .from('equipos')
        .select(EQUIPO_TORNEO_PUBLIC_SELECT)
        .eq('torneo_id', tid)
        .order('puntos_totales', { ascending: false }),
      supabaseAdmin
        .from('partidos')
        .select('equipo_a_id, equipo_b_id, grupo')
        .eq('torneo_id', tid)
        .not('grupo', 'is', null),
      supabaseAdmin
        .from('tabla_puntos')
        .select('equipo_id, posicion')
        .eq('torneo_id', tid),
    ]);
    if (errE) throw errE;

    const puntosRows = puntosResult.error ? [] : (puntosResult.data || []);

    const grupoMap = {};
    (grupoPartidos || []).forEach((p) => {
      if (p.grupo) {
        if (p.equipo_a_id) grupoMap[p.equipo_a_id] = p.grupo;
        if (p.equipo_b_id) grupoMap[p.equipo_b_id] = p.grupo;
      }
    });

    const posicionMap = {};
    (puntosRows || []).forEach((row) => {
      if (row.equipo_id != null) posicionMap[row.equipo_id] = row.posicion;
    });

    const result = (equipos || []).map((eq) =>
      mapEquipoTorneoPublicRow(eq, grupoMap[eq.id] || null, posicionMap[eq.id] ?? null),
    );
    res.json(result);
  } catch (err) {
    sendHttpError(res, err);
  }
});

app.put('/api/equipos/:id', (req, res) => legacyWriteDisabled(res, 'PUT /api/equipos/:id'));

app.delete('/api/equipos/:id', (req, res) => legacyWriteDisabled(res, 'DELETE /api/equipos/:id'));

// ===== PARTIDOS ABIERTOS =====
const partidosRouter = createPartidosRouter({
  supabase,
  supabaseAdmin,
  getAuthenticatedUser,
  computePartidoDeadlineCancel,
  triggerPartidoCreatorPayment,
  pgPool,
});
app.use('/api/partidos', partidosRouter);
/** Alias legacy (SedePublica fallback): misma respuesta que GET /api/partidos/abiertos */
app.get('/api/partidos-abiertos', (req, res, next) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  req.url = `/abiertos${qs}`;
  return partidosRouter(req, res, next);
});
app.use('/api/partidos-abiertos', createPartidosAbiertosRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/xp', createXpRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/chivi', chiviRateLimit, createChiviRouter({ getAuthenticatedUser }));
app.use('/api/ai', aiRateLimit, createAiRouter({ getAuthenticatedUser, pgPool }));
app.use('/api/arena', createArenaRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/rangos', createRangosRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/clases', createClasesRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/membresias', createMembresiasRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/equipos', createEquiposUsuarioRouter({ supabaseAdmin, getAuthenticatedUser }));

// ===== HUB (action card images — public GET /api/hub/imagenes) =====
app.use('/api/hub', createHubRouter({ supabaseAdmin }));
console.log('Hub router registered at /api/hub (GET /api/hub/imagenes)');

app.post('/api/notificaciones/zona-interes', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
    }

    const { deporte, lat, lng } = req.body ?? {};
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);

    if (!deporte || !Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      return res.status(400).json({ error: 'deporte, lat y lng son requeridos' });
    }

    const { error } = await supabaseAdmin
      .from('notificaciones_zona_interes')
      .insert({
        user_id: user.id,
        deporte: String(deporte).toLowerCase(),
        lat: parsedLat,
        lng: parsedLng,
        email: user.email ?? null,
      });

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error POST /api/notificaciones/zona-interes:', err.message);
    sendHttpError(res, err);
  }
});

// ===== PARTIDOS (torneos — rutas legacy) =====
app.get('/api/torneos/:torneo_id/partidos', async (req, res) => {
  try {
    const { torneo_id } = req.params;

    const { data, error } = await supabaseAdmin
      .from('partidos')
      .select(PARTIDO_TORNEO_PUBLIC_SELECT)
      .eq('torneo_id', parseInt(torneo_id, 10))
      .order('fecha_hora', { ascending: true });

    if (error) throw error;
    res.json((data || []).map(mapPartidoTorneoPublicRow));
  } catch (err) {
    sendHttpError(res, err);
  }
});

app.get('/api/partidos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('partidos')
      .select(PARTIDO_TORNEO_DETAIL_PUBLIC_SELECT)
      .eq('id', id)
      .single();

    if (error) throw error;
    res.json(mapPartidoTorneoPublicRow(data));
  } catch (err) {
    sendHttpError(res, err);
  }
}); 

app.put('/api/partidos/:id', (req, res) => legacyWriteDisabled(res, 'PUT /api/partidos/:id'));

// ===== GAMES (legacy writes deshabilitados) =====
app.post('/api/partidos/:partido_id/games', (req, res) => legacyWriteDisabled(res, 'POST /api/partidos/:partido_id/games'));

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
    sendHttpError(res, err);
  }
});

app.put('/api/games/:id', (req, res) => legacyWriteDisabled(res, 'PUT /api/games/:id'));

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
  niveles:      { club_no_oficial: 10, club_oficial: 30, nacional: 100, internacional: 300, mundial: 1000 },
  posiciones:   { 1: 100, 2: 60, 3: 40, 4: 25, 5: 15, 6: 10, 7: 5, 8: 5, 9: 5, 10: 5 },
  tipos_custom: [],
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
    const auth = await requireAdminUser(req, res, {
      getAuthenticatedUser,
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
    });
    if (!auth) return;

    if (auth.role.rol !== 'super_admin') {
      return res.status(403).json({ error: 'No tenés permiso para modificar la configuración de puntos' });
    }

    const { niveles, posiciones, tipos_custom } = req.body;
    const rows = [];
    if (niveles)                    rows.push({ clave: 'niveles',      valor: niveles,      updated_at: new Date() });
    if (posiciones)                 rows.push({ clave: 'posiciones',   valor: posiciones,   updated_at: new Date() });
    if (tipos_custom !== undefined) rows.push({ clave: 'tipos_custom', valor: tipos_custom, updated_at: new Date() });
    if (!rows.length) return res.status(400).json({ error: 'No data provided' });

    const { error } = await supabase
      .from('config_puntos')
      .upsert(rows, { onConflict: 'clave' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error PUT /api/config/puntos:', err.message);
    sendHttpError(res, err);
  }
});

// POST /api/cancelar-reserva — Cancellation with optional credit (JWT + dueño o admin)
app.post('/api/cancelar-reserva', reservasWriteRateLimit, async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
    if (!user) return;

    const { reservaId, email } = req.body;
    if (!reservaId) {
      return res.status(400).json({ error: 'Faltan campos: reservaId, email' });
    }

    const { data: reserva, error: fetchErr } = await supabaseAdmin
      .from('reservas')
      .select('*')
      .eq('id', reservaId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!reserva) {
      return res.status(404).json({ error: 'Reserva no encontrada o no pertenece a este usuario' });
    }

    await assertCancelReservaOwnerCompat(user, reserva, email, {
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
      supabaseAdmin,
      pgPool,
    });

    if (reserva.estado === 'cancelada') return res.status(409).json({ error: 'La reserva ya está cancelada' });

    // Check if reservation is more than 24h away (Argentina UTC-3)
    const horaInicio = reservaHoraInicioFromRow(reserva);
    const reservaDt = new Date(`${reserva.fecha}T${horaInicio}:00-03:00`);
    const nowAR     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const horasHasta = (reservaDt - nowAR) / (1000 * 60 * 60);
    const eligibleForCredit = horasHasta > 24;

    const reservaEmail = reserva.email
      ? String(reserva.email).trim().toLowerCase()
      : String(user.email || '').trim().toLowerCase();

    // Mark as cancelled
    const { error: updateErr } = await supabaseAdmin
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', reservaId);
    if (updateErr) throw updateErr;

    let reputacionCancel = null;
    if (pgPool) {
      try {
        let userIdReputacion = reserva.user_id ? String(reserva.user_id) : null;
        if (!userIdReputacion && reservaEmail) {
          userIdReputacion = await resolveUserIdByEmailPg(pgPool, reservaEmail);
        }
        if (userIdReputacion) {
          reputacionCancel = await procesarReputacionTrasCancelacion(pgPool, {
            userId: userIdReputacion,
            reservaId,
            fecha: reserva.fecha,
            hora: horaInicio,
            horasAnticipacion: horasHasta,
          });
          if (reputacionCancel?.suspension_creada) {
            console.log(`⚠️ Suspensión 7d creada para user ${userIdReputacion} (${reputacionCancel.cancelacion?.id})`);
          }
        } else {
          console.warn(`⚠️ cancelar-reserva ${reservaId}: sin user_id para reputación`);
        }
      } catch (repErr) {
        console.error('❌ reputación tras cancelación:', repErr.message);
      }
    }

    // Credit if eligible
    let credito = null;
    if (eligibleForCredit && reserva.precio > 0 && reservaEmail) {
      // Look up sede_id by name
      const { data: sedeRow } = await supabaseAdmin
        .from('sedes')
        .select('id')
        .eq('nombre', reserva.sede)
        .maybeSingle();

      const venceAt = new Date();
      venceAt.setDate(venceAt.getDate() + 30);

      const { data: creditData, error: creditErr } = await supabaseAdmin
        .from('creditos')
        .insert([{
          email: reservaEmail,
          monto: reserva.precio,
          sede_id: sedeRow?.id || null,
          vence_at: venceAt.toISOString(),
          usado: false,
        }])
        .select()
        .maybeSingle();

      if (!creditErr) credito = creditData;
      else console.error('❌ Error al insertar crédito:', creditErr.message);
    }

    // WhatsApp notification (fire-and-forget)
    if (reserva.whatsapp) {
      const digits = String(reserva.whatsapp).replace(/\D/g, '');
      const to     = `whatsapp:+${digits}`;
      const creditLine = credito !== null
        ? `\n💳 Se acreditaron $${Number(credito.monto).toLocaleString('es-AR')} en tu cuenta (válido 30 días).`
        : '\n⏱ La cancelación fue realizada con menos de 24hs de anticipación — no genera crédito.';

      const body =
`❌ *Reserva cancelada*

📅 ${reserva.fecha} ⏰ ${reserva.hora}
🏟️ ${reserva.sede} — Cancha ${reserva.cancha}
${creditLine}

Si necesitás ayuda, escribinos por WhatsApp.

*PADBOL MATCH*`;

      twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body })
        .catch(err => console.warn('⚠️ WhatsApp cancelación no enviado:', err.message));
    }

    console.log(`✓ Reserva ${reservaId} cancelada — crédito: ${credito ? credito.id : 'no'}`);;
    res.json({
      success: true,
      eligibleForCredit: credito !== null,
      credito,
      reputacion: reputacionCancel,
    });
  } catch (err) {
    const st = err.status || 500;
    if (st >= 400 && st < 500) {
      return res.status(st).json({ error: sanitizeClientErrorMessage(err, st) });
    }
    console.error('❌ Error POST /api/cancelar-reserva:', err.message);
    sendHttpError(res, err);
  }
});

// GET /api/creditos/:email — JWT; propio usuario o admin
app.get('/api/creditos/:email', async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
    if (!user) return;

    const emailParam = decodeURIComponent(req.params.email).trim().toLowerCase();
    const userEmail = String(user.email || '').trim().toLowerCase();
    const role = await resolveAuthRoleForUser(user, {
      fetchUserRoleRowForAuthUser,
      legacySuperAdminEmails: LEGACY_SUPER_ADMIN_EMAILS_API,
    });

    if (!isAdminClubOrSuper(role) && emailParam !== userEmail) {
      return res.status(403).json({ error: 'No tenés permiso para consultar créditos de otro usuario' });
    }

    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('creditos')
      .select('id, monto, sede_id, created_at, vence_at')
      .eq('email', emailParam)
      .eq('usado', false)
      .gt('vence_at', now)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    const total = (data || []).reduce((sum, c) => sum + Number(c.monto), 0);
    console.log(`✓ GET creditos ${maskEmail(emailParam)} — total: ${total} (${(data || []).length} registros)`);
    res.json({ total, creditos: data || [] });
  } catch (err) {
    console.error('❌ Error GET /api/creditos:', err.message);
    sendHttpError(res, err);
  }
});

function serializeRawErrorForLog(err, seen = new WeakSet(), depth = 0) {
  if (err == null) return err;
  if (typeof err !== 'object') return err;
  if (seen.has(err)) return '[Circular]';
  if (depth > 5) return '[MaxDepth]';
  seen.add(err);

  const out = { __type: err.constructor?.name || 'Object' };
  for (const key of Object.getOwnPropertyNames(err)) {
    if (typeof err[key] === 'function') continue;
    const val = err[key];
    out[key] =
      val != null && typeof val === 'object' ? serializeRawErrorForLog(val, seen, depth + 1) : val;
  }
  return out;
}

function logCrearPreferenciaError(phase, err, ctx = {}) {
  console.error('❌ POST /api/crear-preferencia', {
    phase,
    ...summarizeError(err),
    ...ctx,
  });
}

/** Activo solo durante POST /api/crear-preferencia — traza queries Supabase (PA_UNAUTHORIZED). */
let crearPreferenciaSupabaseLogActive = false;
let crearPreferenciaSupabaseLogSeq = 0;

function supabaseClientLabelForLog(client) {
  if (client === supabaseAdmin) return 'supabaseAdmin';
  if (client === supabase) return 'supabase (anon)';
  return 'unknown';
}

function logCrearPreferenciaSupabaseQuery(client, table, operation, params = {}) {
  if (!crearPreferenciaSupabaseLogActive) return;
  crearPreferenciaSupabaseLogSeq += 1;
  console.log('[POST /api/crear-preferencia] Supabase query', {
    seq: crearPreferenciaSupabaseLogSeq,
    table,
    operation,
    client: supabaseClientLabelForLog(client),
    ...(Object.keys(params).length ? { params: safeQueryLog(params) } : {}),
  });
}

// POST /api/crear-preferencia — Mercado Pago Checkout Pro
app.post('/api/crear-preferencia', paymentsRateLimit, async (req, res) => {
  crearPreferenciaSupabaseLogActive = true;
  crearPreferenciaSupabaseLogSeq = 0;
  const ctx = { sedeId: req.body?.sedeId ?? null, titulo: req.body?.titulo ?? null };
  const db = supabaseAdmin;
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
    }

    if (!db) {
      logCrearPreferenciaError('config', new Error('Supabase client no inicializado'), ctx);
      return res.status(503).json({
        error: 'Configuración del servidor incompleta (Supabase no disponible). Contactá soporte.',
      });
    }
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      logCrearPreferenciaError('config', new Error('SUPABASE_SERVICE_ROLE_KEY no configurada'), ctx);
      return res.status(503).json({
        error: 'Configuración del servidor incompleta (SUPABASE_SERVICE_ROLE_KEY). Contactá soporte.',
      });
    }

    const {
      titulo,
      precio,
      moneda,
      sedeNombre,
      reservaData,
      sedeId,
      extras,
    } = req.body;
    if (!titulo) {
      return res.status(400).json({ error: 'Falta campo requerido: titulo' });
    }

    if (!pgPool) {
      return res.status(503).json({ error: 'DATABASE_URL no configurada — no se puede crear reserva pendiente' });
    }

    const quoteInput = normalizeCrearPreferenciaReservaInput(req.body);
    const resolvedSedeId = parsePositiveInt(sedeId ?? quoteInput.sede_id);
    if (resolvedSedeId == null) {
      return res.status(400).json({ error: 'sedeId o sede_id es requerido' });
    }

    let quote;
    try {
      quote = await quoteReservaPrice(db, {
        sedeId: resolvedSedeId,
        deporte: quoteInput.deporte ?? reservaData?.deporte ?? 'padbol',
        duracionMinutos: quoteInput.duracion_minutos ?? reservaData?.duracion_minutos ?? 90,
        fecha: quoteInput.fecha ?? reservaData?.fecha,
        hora: quoteInput.hora ?? quoteInput.hora_inicio ?? reservaData?.hora,
        extras: extras ?? reservaData?.extras ?? [],
        moneda,
      });
    } catch (quoteErr) {
      logCrearPreferenciaError('quote', quoteErr, ctx);
      return res.status(quoteErr.status || 500).json({ error: quoteErr.message || 'No se pudo calcular el precio' });
    }

    try {
      assertClientPrecioMatchesQuote(precio ?? reservaData?.precio ?? req.body?.pricing?.total, quote.total);
    } catch (priceErr) {
      return res.status(priceErr.status || 400).json({
        error: priceErr.message,
        serverTotal: priceErr.serverTotal ?? quote.total,
        clientPrecio: priceErr.clientPrecio ?? precio,
      });
    }

    let client = mpClient;
    if (sedeId) {
      let sedeRow;
      try {
        sedeRow = await fetchSedeMpCredentialsPg(sedeId);
      } catch (sedeTokErr) {
        logCrearPreferenciaError('sede_mp_token', sedeTokErr, ctx);
        throw sedeTokErr;
      }
      if (sedeRow?.mp_access_token) {
        client = new MercadoPagoConfig({ accessToken: sedeRow.mp_access_token });
      } else if (!process.env.MP_ACCESS_TOKEN) {
        return res.status(400).json({
          error:
            'Esta sede no tiene configurado Mercado Pago. Configura el Access Token en Admin → Mi sede → Pagos.',
        });
      }
    } else if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(503).json({ error: 'Mercado Pago no configurado en el servidor (MP_ACCESS_TOKEN)' });
    }

    console.log('[POST /api/crear-preferencia] sede MP credentials loaded from pg');

    let reservaIdParaMp;
    try {
      const pending = await ensureReservaPendienteParaMpPg(pgPool, req.body, {
        authUser: user,
        quote,
        paymentProvider: 'mercadopago',
      });
      reservaIdParaMp = pending.reserva_id;
      console.log(`[POST /api/crear-preferencia] reserva pendiente id=${reservaIdParaMp} (created=${pending.created})`);
    } catch (pendingErr) {
      logCrearPreferenciaError('reserva_pendiente', pendingErr, ctx);
      return res.status(pendingErr.status || 500).json({ error: pendingErr.message || 'No se pudo crear la reserva pendiente' });
    }

    const paymentExtras = quote.extras.map((e) => ({
      id: e.id,
      nombre: e.nombre,
      precio: e.precio,
      moneda: e.moneda,
      cantidad: e.cantidad,
    }));
    const paymentPricing = quote.pricing;
    const items = buildMercadoPagoItems({
      titulo,
      moneda: quote.moneda,
      pricing: paymentPricing,
      extras: paymentExtras,
    });

    const externalReference = String(reservaIdParaMp);

    const preference = new Preference(client);
    const response = await preference.create({
      body: {
        items,
        back_urls: {
          success: `${FRONTEND_URL}/pago-exitoso`,
          failure: `${FRONTEND_URL}/pago-fallido`,
          pending: `${FRONTEND_URL}/pago-fallido`,
        },
        auto_return: 'approved',
        external_reference: externalReference,
        statement_descriptor: sedeNombre || 'Padbol Match',
        notification_url: `${process.env.BACKEND_URL || 'https://padbol-backend.onrender.com'}/api/webhooks/mercadopago`,
      },
    });

    await persistMercadoPagoPreferencePg(pgPool, reservaIdParaMp, response.id);

    console.log(`✓ MP preferencia creada: ${response.id} | reserva_id: ${reservaIdParaMp} | total: ${quote.total} | sede: ${sedeNombre || '—'}`);
    res.json({
      init_point: response.init_point,
      preference_id: response.id,
      reserva_id: reservaIdParaMp,
      precio_esperado: quote.total,
      moneda: quote.moneda,
      pricing: quote.pricing,
    });
  } catch (err) {
    logCrearPreferenciaError('handler', err, ctx);
    if (!res.headersSent) {
      console.error('[MP ERROR DETALLADO]', summarizeError(err));
      res.status(Number.isFinite(Number(err?.status)) ? Number(err.status) : 500).json({
        error: err?.message ?? serializeRawErrorForLog(err)?.message ?? String(err),
      });
    }
  } finally {
    crearPreferenciaSupabaseLogActive = false;
  }
});

// POST /api/crear-pago-stripe — Stripe Checkout Session (quote server-side + reserva pendiente)
app.post('/api/crear-pago-stripe', paymentsRateLimit, async (req, res) => {
  try {
    if (!stripeClient) {
      return res.status(503).json({ error: 'Stripe no configurado en el servidor (STRIPE_SECRET_KEY)' });
    }

    const user = await requireAuthenticatedUser(req, res, getAuthenticatedUser);
    if (!user) return;

    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Configuración del servidor incompleta (Supabase no disponible)' });
    }
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({
        error: 'Configuración del servidor incompleta (SUPABASE_SERVICE_ROLE_KEY). Contactá soporte.',
      });
    }
    if (!pgPool) {
      return res.status(503).json({ error: 'DATABASE_URL no configurada — no se puede crear reserva pendiente' });
    }

    const {
      titulo,
      precio,
      moneda,
      sedeNombre,
      reservaData,
      sedeId,
      extras,
      return_url: returnUrl,
      cancel_url: cancelUrl,
    } = req.body;

    if (!titulo) {
      return res.status(400).json({ error: 'Falta campo requerido: titulo' });
    }

    const quoteInput = normalizeCrearPreferenciaReservaInput(req.body);
    const resolvedSedeId = parsePositiveInt(sedeId ?? quoteInput.sede_id);
    if (resolvedSedeId == null) {
      return res.status(400).json({ error: 'sedeId o sede_id es requerido' });
    }

    const { rows: sedePaymentRows } = await pgPool.query(
      'SELECT metodo_pago, moneda FROM sedes WHERE id = $1 LIMIT 1',
      [resolvedSedeId],
    );
    const sedePaymentRow = sedePaymentRows[0];
    const metodoPago = String(sedePaymentRow?.metodo_pago || '').toLowerCase();
    if (metodoPago && !metodoPago.includes('stripe')) {
      return res.status(400).json({
        error: 'Esta sede no tiene configurado Stripe. Configurá metodo_pago con stripe en Admin → Mi sede → Pagos.',
      });
    }

    let quote;
    try {
      quote = await quoteReservaPrice(supabaseAdmin, {
        sedeId: resolvedSedeId,
        deporte: quoteInput.deporte ?? reservaData?.deporte ?? 'padbol',
        duracionMinutos: quoteInput.duracion_minutos ?? reservaData?.duracion_minutos ?? 90,
        fecha: quoteInput.fecha ?? reservaData?.fecha,
        hora: quoteInput.hora ?? quoteInput.hora_inicio ?? reservaData?.hora,
        extras: extras ?? reservaData?.extras ?? [],
        moneda,
      });
    } catch (quoteErr) {
      return res.status(quoteErr.status || 500).json({ error: quoteErr.message || 'No se pudo calcular el precio' });
    }

    try {
      assertClientPrecioMatchesQuote(
        precio ?? reservaData?.precio ?? req.body?.pricing?.total,
        quote.total,
      );
    } catch (priceErr) {
      return res.status(priceErr.status || 400).json({
        error: priceErr.message,
        serverTotal: priceErr.serverTotal ?? quote.total,
        clientPrecio: priceErr.clientPrecio ?? precio,
      });
    }

    let reservaIdParaStripe;
    try {
      const pending = await ensureReservaPendienteParaMpPg(pgPool, req.body, {
        authUser: user,
        quote,
        paymentProvider: 'stripe',
      });
      reservaIdParaStripe = pending.reserva_id;
    } catch (pendingErr) {
      return res.status(pendingErr.status || 500).json({
        error: pendingErr.message || 'No se pudo crear la reserva pendiente',
      });
    }

    const paymentExtras = quote.extras.map((e) => ({
      id: e.id,
      nombre: e.nombre,
      precio: e.precio,
      moneda: e.moneda,
      cantidad: e.cantidad,
    }));
    const line_items = buildStripeLineItems({
      titulo,
      moneda: quote.moneda,
      pricing: quote.pricing,
      extras: paymentExtras,
    });

    const backendBase = process.env.BACKEND_URL || 'https://padbol-backend.onrender.com';
    const defaultSuccessUrl = `${backendBase}/api/pago-exitoso-stripe?session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancelUrl = cancelUrl || `${FRONTEND_URL}/pago-fallido`;

    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: returnUrl || defaultSuccessUrl,
      cancel_url: defaultCancelUrl,
      client_reference_id: String(reservaIdParaStripe),
      metadata: {
        reserva_id: String(reservaIdParaStripe),
        user_id: String(user.id),
        sede_id: String(resolvedSedeId),
        sede_nombre: sedeNombre || quoteInput.sede || '',
      },
    });

    await persistStripeCheckoutSessionPg(pgPool, reservaIdParaStripe, session.id, {
      payment_provider: 'stripe',
    });

    console.log(
      `✓ Stripe session creada: ${session.id} | reserva_id: ${reservaIdParaStripe} | total: ${quote.total} ${quote.moneda} | sede: ${sedeNombre || '—'}`,
    );

    res.json({
      url: session.url,
      session_url: session.url,
      checkout_url: session.url,
      session_id: session.id,
      reserva_id: reservaIdParaStripe,
      precio_esperado: quote.total,
      moneda: quote.moneda,
      pricing: quote.pricing,
    });
  } catch (err) {
    console.error('❌ Error POST /api/crear-pago-stripe:', err.message);
    res.status(Number.isFinite(Number(err?.status)) ? Number(err.status) : 500).json({
      error: err.message,
    });
  }
});

// ─── Cron: WhatsApp reminder 1 hour before reservation ──────────────────────
cron.schedule('*/5 * * * *', async () => {
  try {
    // Current time in Argentina (UTC-3)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));

    // Target: exactly 1 hour from now
    const target = new Date(now.getTime() + 60 * 60 * 1000);
    const targetFecha = target.toISOString().slice(0, 10); // YYYY-MM-DD
    const targetHora  = target.toTimeString().slice(0, 5);  // HH:MM

    const { data: allDay, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('fecha', targetFecha)
      .eq('estado', 'confirmada')
      .eq('recordatorio_enviado', false);

    if (error) {
      console.error('❌ Cron recordatorio - error Supabase:', error.message);
      return;
    }

    const reservas = (allDay || []).filter(
      (r) => reservaHoraInicioFromRow(r) === targetHora,
    );

    if (!reservas || reservas.length === 0) return;

    console.log(`⏰ Cron: ${reservas.length} recordatorio(s) para ${targetFecha} ${targetHora}`);

    for (const r of reservas) {
      try {
        // Fetch sede address
        const { data: sedeRow } = await supabase
          .from('sedes')
          .select('direccion')
          .eq('nombre', r.sede)
          .maybeSingle();

        const horaDisplay = reservaHoraInicioFromRow(r);
        const body =
`🎾 *¡Te esperamos en ${r.sede}!*

Tu reserva es en 1 hora:
⏰ ${horaDisplay}hs${sedeRow?.direccion ? `\n📍 ${sedeRow.direccion}` : ''}

Recordá llegar 10 minutos antes.
💬 Ante cualquier consulta escribinos por WhatsApp.

*PADBOL MATCH*`;

        const digits = String(r.whatsapp).replace(/\D/g, '');
        const to     = `whatsapp:+${digits}`;
        await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
        console.log(`✓ Recordatorio enviado reserva ${r.id} dest ${maskPhone(digits)}`);

        // Mark as sent
        await supabase
          .from('reservas')
          .update({ recordatorio_enviado: true })
          .eq('id', r.id);

      } catch (err) {
        console.warn(`⚠️ Recordatorio reserva ${r.id} fallido:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Cron recordatorio - error inesperado:', err.message);
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

// ─── Cron: reservas completadas → XP + push post-partido ─────────────────────
initReservasCron({
  supabaseAdmin,
  cron,
  timezone: 'America/Argentina/Buenos_Aires',
});

initReservasHoldCleanupCron({
  supabaseAdmin,
  pgPool,
  cron,
  timezone: 'America/Argentina/Buenos_Aires',
});

// ─── Auto-cancel incomplete partidos past deadline (every 15 min) ───────────
const PARTIDO_AUTO_CANCEL_MS = 15 * 60 * 1000;

async function runPartidoAutoCancelCron() {
  try {
    const now = new Date().toISOString();
    const { data: partidos, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, reserva_id, jugadores_confirmados, jugadores_requeridos')
      .eq('estado', 'abierto')
      .lte('deadline_cancel', now);

    if (error) throw error;
    if (!partidos?.length) return;

    for (const partido of partidos) {
      const needed = partido.jugadores_requeridos ?? partido.jugadores_necesarios ?? 4;
      const current = partido.jugadores_confirmados ?? partido.jugadores_actuales ?? 0;
      if (current >= needed) continue;

      if (partido.reserva_id) {
        await supabaseAdmin
          .from('reservas')
          .update({ estado: 'cancelada', pago_estado: 'no_aplica' })
          .eq('id', partido.reserva_id);
      }

      await supabaseAdmin
        .from('partidos_abiertos')
        .update({ estado: 'cancelado' })
        .eq('id', partido.id);

      console.log(`[CRON] Partido ${partido.id} auto-cancelado por tiempo`);
    }
  } catch (err) {
    console.error('❌ [CRON] partidos auto-cancel error:', err.message);
  }
}

setInterval(runPartidoAutoCancelCron, PARTIDO_AUTO_CANCEL_MS);
runPartidoAutoCancelCron();

// ===== USUARIOS =====

async function countPartidosJugados({ email, supabaseUserId }) {
  const filters = [];
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);
  if (supabaseUserId) filters.push(`user_id.eq.${supabaseUserId}`);

  if (filters.length === 0) return 0;

  const { count, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('*', { count: 'exact', head: true })
    .or(filters.join(','));

  if (error) throw error;
  return count ?? 0;
}

async function countPartidosArmados(supabaseUserId) {
  if (!supabaseUserId) return 0;

  const { count, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('*', { count: 'exact', head: true })
    .eq('capitan_user_id', supabaseUserId);

  if (error) throw error;
  return count ?? 0;
}

async function computeTasaCompletados(supabaseUserId) {
  if (!supabaseUserId) return 0;

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('estado')
    .eq('capitan_user_id', supabaseUserId);

  if (error) throw error;

  const rows = data ?? [];
  if (rows.length === 0) return 0;

  const completos = rows.filter((row) => row.estado === 'completo').length;
  return Math.round((completos / rows.length) * 100);
}

async function fetchUltimosPartidosUsuario({ email, supabaseUserId }, limit = 5) {
  const filters = [];
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);
  if (supabaseUserId) filters.push(`user_id.eq.${supabaseUserId}`);

  if (filters.length === 0) return [];

  const { data: joins, error: joinErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('partido_id, joined_at')
    .or(filters.join(','))
    .order('joined_at', { ascending: false })
    .limit(30);

  if (joinErr) throw joinErr;

  const partidoIds = [...new Set((joins ?? []).map((row) => row.partido_id).filter(Boolean))];
  if (partidoIds.length === 0) return [];

  const { data: partidos, error: partidosErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, sede_nombre, fecha, hora, estado, deporte')
    .in('id', partidoIds);

  if (partidosErr) throw partidosErr;

  const joinOrder = new Map(partidoIds.map((id, index) => [id, index]));

  return (partidos ?? [])
    .sort((a, b) => (joinOrder.get(a.id) ?? 99) - (joinOrder.get(b.id) ?? 99))
    .slice(0, limit)
    .map((partido) => ({
      partido_id: partido.id,
      sede_nombre: partido.sede_nombre ?? 'Sede',
      fecha: partido.fecha,
      hora: partido.hora ? String(partido.hora).slice(0, 5) : null,
      estado: partido.estado ?? 'abierto',
      deporte: partido.deporte ?? 'padbol',
    }));
}

const DEPORTE_LABEL_TO_KEY = {
  padbol: 'padbol',
  padel: 'padel',
  pádel: 'padel',
  pickleball: 'pickleball',
  tenis: 'tenis',
  futbol: 'futbol',
  fútbol: 'futbol',
  squash: 'squash',
};

function deporteValueToKey(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  return DEPORTE_LABEL_TO_KEY[lower] ?? DEPORTE_LABEL_TO_KEY[trimmed] ?? lower;
}

async function syncJugadorDeportesForUser(userId, deportesRaw) {
  const keys = [...new Set(parsePerfilDeportes(deportesRaw).map(deporteValueToKey).filter(Boolean))];
  if (!userId || keys.length === 0) return keys;

  await supabaseAdmin.from('jugador_deportes').delete().eq('user_id', userId);

  const rows = keys.map((deporte) => ({ user_id: userId, deporte }));
  const { error } = await supabaseAdmin.from('jugador_deportes').insert(rows);
  if (error) {
    console.warn('⚠️ syncJugadorDeportesForUser:', error.message);
  }

  return keys;
}

function formatTournamentPlayerName(perfil) {
  const nombre = String(perfil?.nombre ?? '').trim();
  const apellido = String(perfil?.apellido ?? '').trim();
  const full = [nombre, apellido].filter(Boolean).join(' ');
  return full || nombre || String(perfil?.apodo ?? '').trim() || 'Jugador';
}

function parsePerfilDeportes(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      return raw.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

async function resolvePerfilDeportes(perfil, supabaseUserId) {
  const fromPerfil = parsePerfilDeportes(perfil?.deportes);
  if (fromPerfil.length > 0) return fromPerfil;

  if (supabaseUserId) {
    const { data: jugadorDeportes, error } = await supabaseAdmin
      .from('jugador_deportes')
      .select('deporte')
      .eq('user_id', supabaseUserId);

    if (!error && (jugadorDeportes ?? []).length > 0) {
      return [...new Set(jugadorDeportes.map((row) => row.deporte).filter(Boolean))];
    }
  }

  const ultimos = await fetchUltimosPartidosUsuario({
    email: perfil?.email,
    supabaseUserId,
  }, 10);

  const fromPartidos = [...new Set(ultimos.map((row) => row.deporte).filter(Boolean))];
  if (fromPartidos.length > 0) return fromPartidos;

  return ['padbol'];
}

async function resolvePerfilCreatedAt(perfil) {
  if (perfil?.created_at) return perfil.created_at;

  if (!perfil?.user_id) return null;

  const { data, error } = await supabaseAdmin.auth.admin.getUserById(perfil.user_id);
  if (error || !data?.user) return null;
  return data.user.created_at ?? null;
}

async function countReservasForUser({ email, supabaseUserId }) {
  const filters = [];
  if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);
  if (supabaseUserId) filters.push(`user_id.eq.${supabaseUserId}`);

  if (filters.length === 0) return 0;

  const { count, error } = await supabaseAdmin
    .from('reservas')
    .select('*', { count: 'exact', head: true })
    .or(filters.join(','));

  if (error) throw error;
  return count ?? 0;
}

async function getRankingEntryForEmail(email) {
  if (!email) return null;

  const SCOPE_NIVELES = {
    internacional: ['internacional', 'mundial'],
  };
  const nivelesPermitidos = SCOPE_NIVELES.internacional;

  const { data: torneos, error: errT } = await supabase
    .from('torneos')
    .select('id, sede_id, nivel_torneo, nombre')
    .eq('estado', 'finalizado')
    .in('nivel_torneo', nivelesPermitidos);

  if (errT) throw errT;
  if (!torneos?.length) return null;

  const torneoIds = torneos.map((t) => t.id);

  const { data: puntos, error: errP } = await supabase
    .from('tabla_puntos')
    .select('torneo_id, equipo_id, posicion, puntos')
    .in('torneo_id', torneoIds);

  if (errP) throw errP;
  if (!puntos?.length) return null;

  const equipoIds = [...new Set(puntos.map((p) => p.equipo_id))];
  const { data: equipos, error: errE } = await supabase
    .from('equipos')
    .select('id, nombre, jugadores')
    .in('id', equipoIds);

  if (errE) throw errE;

  const equipoMap = {};
  (equipos || []).forEach((e) => { equipoMap[e.id] = e; });

  const playerMap = {};
  puntos.forEach((p) => {
    const equipo = equipoMap[p.equipo_id];
    if (!equipo) return;
    const jugadores = Array.isArray(equipo.jugadores) ? equipo.jugadores : [];

    if (jugadores.length === 0) {
      const key = `equipo:${equipo.id}`;
      if (!playerMap[key]) {
        playerMap[key] = {
          nombre: equipo.nombre,
          email: null,
          nivel: null,
          puntos_total: 0,
          torneos_count: 0,
        };
      }
      playerMap[key].puntos_total += p.puntos;
      playerMap[key].torneos_count += 1;
      return;
    }

    jugadores.forEach((j) => {
      const key = j.email || j.nombre;
      if (!key) return;
      if (!playerMap[key]) {
        playerMap[key] = {
          nombre: j.nombre || key,
          email: j.email || null,
          nivel: null,
          puntos_total: 0,
          torneos_count: 0,
        };
      }
      playerMap[key].puntos_total += p.puntos;
      playerMap[key].torneos_count += 1;
    });
  });

  const emails = Object.values(playerMap).map((p) => p.email).filter(Boolean);
  if (emails.length > 0) {
    const { data: perfiles } = await supabase
      .from('jugadores_perfil')
      .select('email, nombre, nivel')
      .in('email', emails);

    (perfiles || []).forEach((perfil) => {
      const entry = playerMap[perfil.email];
      if (!entry) return;
      entry.nombre = perfil.nombre || entry.nombre;
      entry.nivel = perfil.nivel || entry.nivel;
    });
  }

  const result = Object.values(playerMap)
    .sort((a, b) => b.puntos_total - a.puntos_total || b.torneos_count - a.torneos_count);

  const normalizedEmail = email.toLowerCase();
  const index = result.findIndex(
    (entry) => entry.email?.toLowerCase() === normalizedEmail,
  );

  if (index === -1) return null;

  return {
    ranking_position: index + 1,
    torneos: result[index].torneos_count ?? 0,
    categoria_ranking: result[index].nivel ?? null,
    puntos_total: result[index].puntos_total ?? 0,
  };
}

async function getSedesHabituales({ email, supabaseUserId, primarySedeId }) {
  const sedeCounts = {};

  function addSede(sedeId, weight = 1) {
    if (sedeId == null) return;
    const key = String(sedeId);
    sedeCounts[key] = (sedeCounts[key] || 0) + weight;
  }

  if (primarySedeId != null) {
    addSede(primarySedeId, 3);
  }

  if (email) {
    const { data: reservas } = await supabaseAdmin
      .from('reservas')
      .select('sede, sede_id')
      .eq('email', email);

    for (const reserva of reservas || []) {
      if (reserva.sede_id != null) {
        addSede(reserva.sede_id);
      } else if (reserva.sede) {
        const { data: sedeRow } = await supabaseAdmin
          .from('sedes')
          .select('id')
          .eq('nombre', reserva.sede)
          .maybeSingle();
        addSede(sedeRow?.id);
      }
    }
  }

  const joinFilters = [];
  if (email) joinFilters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);
  if (supabaseUserId) joinFilters.push(`user_id.eq.${supabaseUserId}`);

  if (joinFilters.length > 0) {
    const { data: joins } = await supabaseAdmin
      .from('partidos_abiertos_jugadores')
      .select('partido_id, partidos_abiertos ( sede_id )')
      .or(joinFilters.join(','));

    (joins || []).forEach((join) => {
      addSede(join.partidos_abiertos?.sede_id);
    });
  }

  const topSedeIds = Object.entries(sedeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sedeId]) => parseInt(sedeId, 10))
    .filter((id) => !Number.isNaN(id));

  if (topSedeIds.length === 0) return [];

  const { data: sedes, error } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre, ciudad, provincia, pais')
    .in('id', topSedeIds);

  if (error) throw error;

  const sedeMap = Object.fromEntries((sedes || []).map((sede) => [sede.id, sede]));
  return topSedeIds
    .map((id) => sedeMap[id])
    .filter(Boolean);
}

const JUGADOR_RANKING_TIPOS = new Set(['club', 'nacional', 'fipa']);

function isMissingJugadorRankingsTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('jugador_rankings')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function normalizeJugadorRankingRow(row) {
  const tipo = String(row?.tipo ?? '').trim().toLowerCase();
  const posicion = Number(row?.posicion);
  if (!JUGADOR_RANKING_TIPOS.has(tipo) || !Number.isFinite(posicion) || posicion <= 0) {
    return null;
  }

  return {
    tipo,
    deporte: String(row?.deporte ?? '').trim(),
    categoria: String(row?.categoria ?? '').trim(),
    posicion: Math.floor(posicion),
  };
}

async function fetchJugadorRankingsForUserId(userId) {
  if (!userId) return [];

  const { data, error } = await supabaseAdmin
    .from('jugador_rankings')
    .select('tipo, deporte, categoria, posicion')
    .eq('user_id', userId)
    .gt('posicion', 0);

  if (error) {
    if (isMissingJugadorRankingsTable(error)) return [];
    throw error;
  }

  const tipoOrder = { club: 0, nacional: 1, fipa: 2 };
  return (data ?? [])
    .map(normalizeJugadorRankingRow)
    .filter(Boolean)
    .sort((a, b) => {
      const orderDiff = (tipoOrder[a.tipo] ?? 99) - (tipoOrder[b.tipo] ?? 99);
      if (orderDiff !== 0) return orderDiff;
      return a.deporte.localeCompare(b.deporte) || a.categoria.localeCompare(b.categoria);
    });
}

function mapCompaneroHabitualResponse(row) {
  if (!row?.user_id) return null;
  return {
    user_id: row.user_id,
    nombre: row.nombre ?? '',
    apodo: row.apodo ?? null,
    foto_url: row.foto_url ?? null,
    username: row.username ?? null,
  };
}

async function fetchCompaneroHabitualById(companeroId) {
  if (!companeroId) return null;

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id, nombre, apodo, username, foto_url')
    .eq('user_id', companeroId)
    .maybeSingle();

  if (error) {
    const message = String(error.message ?? '').toLowerCase();
    if (error.code === '42703' || message.includes('companero_habitual')) return null;
    throw error;
  }

  return data ? mapCompaneroHabitualResponse(data) : null;
}

async function countVictoriasForUser({ email, supabaseUserId }) {
  // Placeholder until tournament/partido win aggregation is defined.
  void email;
  void supabaseUserId;
  return 0;
}

async function buildAuthenticatedPerfilPayload(perfil, user, deportes) {
  const userId = perfil.user_id ?? user.id;
  const companero = await fetchCompaneroHabitualById(perfil.companero_habitual_id ?? null);

  return {
    nombre: perfil.nombre ?? '',
    nombre_saludo: perfil.nombre_saludo ?? null,
    apellido: perfil.apellido ?? '',
    telefono: perfil.telefono ?? '',
    nivel: perfil.nivel ?? '',
    lateralidad: perfil.lateralidad ?? '',
    posicion_cancha: perfil.posicion_cancha ?? null,
    pais: perfil.pais ?? '',
    email: perfil.email ?? user.email ?? '',
    foto_url: perfil.foto_url ?? null,
    username: perfil.username ?? null,
    apodo: perfil.apodo ?? null,
    companero_habitual_id: perfil.companero_habitual_id ?? null,
    companero_habitual: companero,
    deporte_principal: deportes[0] ?? null,
    deportes,
    xp: perfil.xp ?? 0,
    liga: perfil.liga ?? 'INIT',
  };
}

const jugadorRouter = express.Router();

async function handleGetAuthenticatedPerfil(req, res) {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const filters = buildUserEmailOrIdFilters(user, {
      emailField: 'email',
      userIdFields: ['user_id'],
    });

    if (filters.length === 0) {
      return res.status(400).json({ error: 'Usuario sin identificador válido' });
    }

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .select(`
        user_id, nombre, nombre_saludo, apellido, telefono, nivel, lateralidad, posicion_cancha,
        pais, email, foto_url, username, apodo, companero_habitual_id, xp, liga
      `)
      .or(filters.join(','))
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    const deportes = await resolvePerfilDeportes(data, data.user_id ?? user.id);
    res.json(await buildAuthenticatedPerfilPayload(data, user, deportes));
  } catch (err) {
    console.error('❌ Error GET jugador perfil:', err.message);
    sendHttpError(res, err);
  }
}

async function handlePutAuthenticatedPerfil(req, res) {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const email = user.email;
    if (!email) {
      return res.status(400).json({ error: 'Usuario sin email' });
    }

    const {
      nombre,
      apellido,
      telefono,
      nivel,
      lateralidad,
      posicion_cancha: posicionCancha,
      pais,
      username,
      apodo,
      deportes,
      companero_habitual_id: companeroHabitualId,
    } = req.body;

    const rawUsername = username ?? null;
    const normalizedUsername =
      rawUsername != null ? String(rawUsername).replace(/^@+/, '').trim() : null;

    const updatePayload = {};

    if (nombre != null) updatePayload.nombre = String(nombre).trim();
    if (apellido != null) updatePayload.apellido = String(apellido).trim();
    if (telefono != null) updatePayload.telefono = telefono;
    if (nivel != null) updatePayload.nivel = nivel;
    if (lateralidad != null) updatePayload.lateralidad = lateralidad;
    if (posicionCancha != null) {
      const trimmed = String(posicionCancha).trim();
      updatePayload.posicion_cancha = trimmed || null;
    }
    if (pais != null) updatePayload.pais = pais;
    if (apodo !== undefined && apodo !== '') {
      const trimmedApodo = String(apodo).trim();
      if (trimmedApodo) {
        updatePayload.apodo = trimmedApodo;
      }
    }
    if (normalizedUsername) {
      updatePayload.username = normalizedUsername;
    }
    if (Array.isArray(deportes)) {
      updatePayload.deportes = deportes;
    }
    if (companeroHabitualId !== undefined) {
      if (companeroHabitualId == null || companeroHabitualId === '') {
        updatePayload.companero_habitual_id = null;
      } else if (UUID_REGEX.test(String(companeroHabitualId))) {
        updatePayload.companero_habitual_id = String(companeroHabitualId);
      } else {
        return res.status(400).json({ error: 'companero_habitual_id inválido' });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .update(updatePayload)
      .eq('email', email)
      .select(`
        user_id, nombre, nombre_saludo, apellido, telefono, nivel, lateralidad, posicion_cancha,
        pais, email, foto_url, username, apodo, companero_habitual_id, xp, liga
      `);

    if (error) throw error;
    if (!data?.length) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    const perfil = data[0];

    if (Array.isArray(deportes) && perfil.user_id) {
      await syncJugadorDeportesForUser(perfil.user_id, deportes);
    }

    const resolvedDeportes = await resolvePerfilDeportes(perfil, perfil.user_id ?? user.id);

    console.log(`✓ PUT jugador perfil — user ${user.id}`);
    res.json(await buildAuthenticatedPerfilPayload(perfil, user, resolvedDeportes));
  } catch (err) {
    console.error('❌ Error PUT jugador perfil:', err.message);
    sendHttpError(res, err);
  }
}

// GET /api/jugador/perfil — Authenticated player profile
jugadorRouter.get('/perfil', handleGetAuthenticatedPerfil);

// PUT /api/jugador/perfil — Update authenticated player profile
jugadorRouter.put('/perfil', handlePutAuthenticatedPerfil);

// GET /api/jugador/perfiles?user_ids=uuid1,uuid2 — Batch jugadores_perfil for partido slots
jugadorRouter.get('/perfiles', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const userIds = String(req.query.user_ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (userIds.length === 0) {
      return res.json([]);
    }

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('user_id, nombre, nombre_saludo, apodo, username, foto_url')
      .in('user_id', userIds);

    if (error) throw error;

    return res.json((data ?? []).map((row) => ({
      user_id: row.user_id,
      nombre: row.nombre ?? null,
      nombre_saludo: row.nombre_saludo ?? null,
      apodo: row.apodo ?? null,
      username: row.username ?? null,
      foto_url: row.foto_url ?? null,
    })));
  } catch (err) {
    console.error('❌ Error GET /api/jugador/perfiles:', err.message);
    return sendHttpError(res, err);
  }
});

// GET /api/jugador/rankings — Authenticated player's earned ranking positions
jugadorRouter.get('/rankings', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const rankings = await fetchJugadorRankingsForUserId(user.id);
    res.json({ rankings });
  } catch (err) {
    console.error('❌ Error GET /api/jugador/rankings:', err.message);
    sendHttpError(res, err);
  }
});

mountJugadorReputacionRoutes(jugadorRouter, { supabaseAdmin, getAuthenticatedUser });

const usuariosRouter = express.Router();

// POST /api/usuarios/push-token — Save Expo push token on jugadores_perfil
usuariosRouter.post('/push-token', pushTokensRateLimit, async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const pushToken = req.body?.push_token ?? req.body?.expo_push_token ?? null;
    if (!pushToken) {
      return res.status(400).json({ error: 'push_token es requerido' });
    }

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .update({ push_token: pushToken, expo_push_token: pushToken })
      .eq('user_id', user.id)
      .select('id');

    if (error) throw error;
    if (!data?.length) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    console.log(`✓ POST /api/usuarios/push-token — token guardado para ${user.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error POST /api/usuarios/push-token:', err.message);
    sendHttpError(res, err);
  }
});

// GET /api/usuarios/check-username?username= — Username availability (case insensitive)
usuariosRouter.get('/check-username', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const username = String(req.query.username ?? '').replace(/^@+/, '').trim().toLowerCase();
    if (!username || username.length < 2) {
      return res.json({ available: false });
    }

    const escaped = username.replace(/"/g, '\\"');
    let rows = [];

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('id, user_id, username, apodo')
      .or(`username.ilike."${escaped}",apodo.ilike."${escaped}"`);

    if (error) {
      const { data: fallbackRows, error: fallbackErr } = await supabaseAdmin
        .from('jugadores_perfil')
        .select('id, user_id, apodo')
        .ilike('apodo', username);

      if (fallbackErr) throw fallbackErr;
      rows = fallbackRows ?? [];
    } else {
      rows = data ?? [];
    }

    const taken = rows.some((row) => {
      const rowHandle = String(row.username ?? row.apodo ?? '')
        .replace(/^@+/, '')
        .trim()
        .toLowerCase();

      if (rowHandle !== username) return false;

      const rowUserId = row.user_id ?? null;
      return rowUserId !== user.id;
    });

    res.json({ available: !taken });
  } catch (err) {
    console.error('❌ Error GET /api/usuarios/check-username:', err.message);
    sendHttpError(res, err);
  }
});

// GET /api/usuarios/buscar?q=&partido_id= — Search players to invite to a partido
usuariosRouter.get('/buscar', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const q = String(req.query.q ?? '').replace(/^@+/, '').trim();
    if (q.length < 2) {
      return res.json([]);
    }

    const partidoId = parseInt(req.query.partido_id, 10);
    const escaped = q.replace(/"/g, '\\"');

    let excludeUserIds = new Set([user.id]);

    if (!Number.isNaN(partidoId)) {
      const { data: partido, error: partidoErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .select('id, capitan_user_id, fecha, hora, duracion_minutos, reserva_id')
        .eq('id', partidoId)
        .maybeSingle();

      if (partidoErr) throw partidoErr;

      if (partido?.capitan_user_id) {
        excludeUserIds.add(partido.capitan_user_id);
      }

      const { data: jugadores, error: jugadoresErr } = await supabaseAdmin
        .from('partidos_abiertos_jugadores')
        .select('user_id')
        .eq('partido_id', partidoId);

      if (jugadoresErr) throw jugadoresErr;
      (jugadores ?? []).forEach((row) => {
        if (row.user_id) excludeUserIds.add(row.user_id);
      });

      const { data: solicitudes, error: solErr } = await supabaseAdmin
        .from('solicitudes_partido')
        .select('solicitante_id, estado, created_at, expires_at')
        .eq('partido_id', partidoId)
        .in('estado', ['pendiente', 'invitado']);

      if (solErr) throw solErr;
      (solicitudes ?? []).forEach((row) => {
        if (!row.solicitante_id) return;
        if (!isSolicitudPendienteActiva(row, partido)) return;
        excludeUserIds.add(row.solicitante_id);
      });
    }

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('user_id, nombre, nombre_saludo, apodo, username, foto_url, nivel')
      .or(
        `nombre.ilike."%${escaped}%",apodo.ilike."%${escaped}%",nombre_saludo.ilike."%${escaped}%",username.ilike."%${escaped}%"`,
      )
      .limit(10);

    if (error) throw error;

    const results = (data ?? [])
      .filter((row) => row.user_id && !excludeUserIds.has(row.user_id))
      .map((row) => ({
        user_id: row.user_id,
        nombre: row.nombre_saludo ?? row.nombre ?? 'Jugador',
        username: row.username ?? row.apodo ?? row.nombre_saludo ?? null,
        foto_url: row.foto_url ?? null,
        nivel: row.nivel ?? 'Intermedio',
      }));

    res.json(results);
  } catch (err) {
    console.error('❌ Error GET /api/usuarios/buscar:', err.message);
    sendHttpError(res, err);
  }
});

// GET /api/usuarios/perfil — Current user profile from jugadores_perfil
usuariosRouter.get('/perfil', handleGetAuthenticatedPerfil);

// POST /api/usuarios/perfil — Create or complete jugadores_perfil for authenticated user
usuariosRouter.post('/perfil', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const email = user.email;
    if (!email) {
      return res.status(400).json({ error: 'Usuario sin email' });
    }

    const { nombre, apellido, nivel, username, apodo, deporte, deporte_principal } = req.body ?? {};
    const trimmedNombre = String(nombre ?? '').trim();
    const trimmedApellido = String(apellido ?? '').trim();
    const trimmedNivel = String(nivel ?? '').trim();
    const trimmedApodo = String(apodo ?? '').trim();
    const deporteKey = String(deporte_principal ?? deporte ?? '')
      .trim()
      .toLowerCase();

    const rawUsername = username ?? apodo ?? null;
    const normalizedUsername =
      rawUsername != null ? String(rawUsername).replace(/^@+/, '').trim() : null;

    if (trimmedNombre.length < 2) {
      return res.status(400).json({ error: 'nombre es requerido (mínimo 2 caracteres)' });
    }
    if (!normalizedUsername || normalizedUsername.length < 2) {
      return res.status(400).json({ error: 'username es requerido (mínimo 2 caracteres)' });
    }
    if (normalizedUsername.length > 20) {
      return res.status(400).json({ error: 'username no puede superar 20 caracteres' });
    }
    if (!trimmedNivel) {
      return res.status(400).json({ error: 'nivel es requerido' });
    }
    if (!deporteKey) {
      return res.status(400).json({ error: 'deporte_principal es requerido' });
    }

    const filters = buildUserEmailOrIdFilters(user, {
      emailField: 'email',
      userIdFields: ['user_id'],
    });

    if (filters.length === 0) {
      return res.status(400).json({ error: 'Usuario sin identificador válido' });
    }

    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('id, email, user_id')
      .or(filters.join(','))
      .limit(1);

    if (existingError) throw existingError;

    const profilePayload = {
      nombre: trimmedNombre,
      apellido: trimmedApellido || null,
      nivel: trimmedNivel,
      email,
      user_id: user.id,
    };

    if (normalizedUsername) {
      profilePayload.username = normalizedUsername;
    }
    if (trimmedApodo) {
      profilePayload.apodo = trimmedApodo;
    }

    let perfil = null;

    if (existingRows?.length) {
      const { data, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .update(profilePayload)
        .eq('id', existingRows[0].id)
        .select('nombre, apellido, telefono, nivel, lateralidad, pais, email, foto_url, username, apodo, user_id, deportes');

      if (error) throw error;
      perfil = data?.[0] ?? null;
    } else {
      const { data, error } = await supabaseAdmin
        .from('jugadores_perfil')
        .insert(profilePayload)
        .select('nombre, apellido, telefono, nivel, lateralidad, pais, email, foto_url, username, apodo, user_id, deportes');

      if (error) throw error;
      perfil = data?.[0] ?? null;
    }

    if (!perfil) {
      return res.status(500).json({ error: 'No se pudo guardar el perfil' });
    }

    await supabaseAdmin.from('jugador_deportes').delete().eq('user_id', user.id);
    const { error: deporteError } = await supabaseAdmin
      .from('jugador_deportes')
      .insert({ user_id: user.id, deporte: deporteKey });

    if (deporteError) {
      console.warn('⚠️ jugador_deportes insert:', deporteError.message);
    }

    const deportes = [deporteKey];

    console.log(`✓ POST /api/usuarios/perfil — user ${user.id}`);
    res.status(existingRows?.length ? 200 : 201).json({
      nombre: perfil.nombre ?? '',
      telefono: perfil.telefono ?? '',
      nivel: perfil.nivel ?? '',
      apellido: perfil.apellido ?? '',
      lateralidad: perfil.lateralidad ?? '',
      pais: perfil.pais ?? '',
      email: perfil.email ?? email,
      foto_url: perfil.foto_url ?? null,
      username: perfil.username ?? null,
      apodo: perfil.apodo ?? null,
      deporte_principal: deportes[0] ?? null,
      deportes,
    });
  } catch (err) {
    console.error('❌ Error POST /api/usuarios/perfil:', err.message);
    sendHttpError(res, err);
  }
});

// PUT /api/usuarios/perfil — Update jugadores_perfil for authenticated user
usuariosRouter.put('/perfil', handlePutAuthenticatedPerfil);

// POST /api/usuarios/foto-perfil — Upload profile photo to Supabase Storage
usuariosRouter.post('/foto-perfil', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const email = user.email;
    if (!email) {
      return res.status(400).json({ error: 'Usuario sin email' });
    }

    const { foto_base64, mime_type } = req.body;
    if (!foto_base64) {
      return res.status(400).json({ error: 'foto_base64 es requerido' });
    }

    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const normalizedMime = (mime_type || 'image/jpeg').toLowerCase();
    if (!allowedMimeTypes.includes(normalizedMime)) {
      return res.status(400).json({ error: 'mime_type de imagen no soportado' });
    }

    const base64Data = String(foto_base64).replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (!buffer.length) {
      return res.status(400).json({ error: 'Imagen inválida' });
    }

    const maxBytes = 5 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      return res.status(400).json({ error: 'La imagen supera el tamaño máximo permitido (5 MB)' });
    }

    const filePath = `${user.id}.jpg`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from('fotos-perfil')
      .upload(filePath, buffer, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseAdmin.storage
      .from('fotos-perfil')
      .getPublicUrl(filePath);

    const foto_url = publicUrlData.publicUrl;

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .update({ foto_url })
      .eq('email', email)
      .select('foto_url');

    if (error) throw error;
    if (!data?.length) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    console.log(`✓ POST /api/usuarios/foto-perfil — user ${user.id}`);
    res.json({ foto_url });
  } catch (err) {
    console.error('❌ Error POST /api/usuarios/foto-perfil:', err.message);
    sendHttpError(res, err);
  }
});

// GET /api/usuarios/perfil-publico/:identifier — alias público (ver mountJugadorPerfilPublicoRoutes)

mountJugadorPerfilPublicoRoutes(app, { pgPool, jugadorRouter, usuariosRouter });

app.use('/api/usuarios', usuariosRouter);
app.use('/api/jugador', jugadorRouter);

// ===== CHECKIN =====
const checkinRouter = express.Router();

// POST /api/checkin/verificar — Verify QR and mark reservation check-in
checkinRouter.post('/verificar', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const { qr_code, sede_id } = req.body;
    if (!qr_code || sede_id == null) {
      return res.status(400).json({ error: 'qr_code y sede_id son requeridos' });
    }

    const qrData = parseCheckinQrCode(qr_code);
    if (!qrData) {
      return res.status(400).json({ error: 'QR inválido: no se pudo interpretar el código' });
    }

    const { reserva_id, user_id: qrUserId, sede_id: qrSedeId, fecha: qrFecha } = qrData;

    if (!reserva_id) {
      return res.status(400).json({ error: 'QR inválido: falta reserva_id' });
    }

    if (qrSedeId != null && Number(qrSedeId) !== Number(sede_id)) {
      return res.status(400).json({ error: 'El QR no corresponde a la sede indicada' });
    }

    const { data: reserva, error: fetchErr } = await supabaseAdmin
      .from('reservas')
      .select('*')
      .eq('id', reserva_id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!reserva) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    const sedeMatches = await reservaMatchesSedeId(reserva, sede_id);
    if (!sedeMatches) {
      return res.status(400).json({ error: 'La reserva no pertenece a esta sede' });
    }

    if (!reservaBelongsToUser(reserva, user, qrUserId)) {
      return res.status(403).json({ error: 'La reserva no pertenece al usuario autenticado' });
    }

    const today = getTodayArgentinaDate();
    const reservaFecha = String(reserva.fecha).slice(0, 10);
    if (reservaFecha !== today) {
      return res.status(400).json({ error: 'El check-in solo está disponible el día de la reserva' });
    }

    if (qrFecha && String(qrFecha).slice(0, 10) !== reservaFecha) {
      return res.status(400).json({ error: 'La fecha del QR no coincide con la reserva' });
    }

    const allowedStates = ['confirmada'];
    if (!allowedStates.includes(reserva.estado)) {
      return res.status(400).json({
        error: `Estado de reserva no válido para check-in: ${reserva.estado ?? 'desconocido'}`,
      });
    }

    if (reserva.checkin_realizado) {
      return res.status(409).json({ error: 'El check-in ya fue realizado para esta reserva' });
    }

    const checkinAt = new Date().toISOString();
    const { error: updateErr } = await supabaseAdmin
      .from('reservas')
      .update({
        checkin_realizado: true,
        checkin_at: checkinAt,
      })
      .eq('id', reserva_id);

    if (updateErr) throw updateErr;

    const sedeNombre = await getSedeNombre(reserva, sede_id);

    console.log(`✓ POST /api/checkin/verificar — reserva ${reserva_id} check-in OK`);
    res.json({
      success: true,
      cancha: reserva.cancha,
      cancha_asignada: reserva.cancha,
      hora: reserva.hora,
      sede: sedeNombre,
    });
  } catch (err) {
    console.error('❌ Error POST /api/checkin/verificar:', err.message);
    sendHttpError(res, err);
  }
});

app.use('/api/checkin', checkinRouter);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Ruta no encontrada' });
});

app.use((err, _req, res, _next) => {
  logServerError('Error no capturado', err);
  if (!res.headersSent) {
    const { status, body } = buildClientErrorPayload(err);
    res.status(status).json(body);
  }
});

(async () => {
  await verifyPgPoolConnection();
  httpServer.listen(PORT, () => {
    console.log(`🚀 Padbol Match API running on port ${PORT}`);
    console.log('✅ Rutas rol: GET /api/auth/mi-rol');
    console.log('✅ Rutas rol: GET /api/usuarios/mi-rol');
    console.log(`📊 Supabase: ${SUPABASE_URL}`);
    console.log('🔑 Supabase env:', {
      SUPABASE_KEY: envConfigured('SUPABASE_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: envConfigured('SUPABASE_SERVICE_ROLE_KEY'),
    });
    console.log(`🛡️ Rate limits: ${isRateLimitDisabled() ? 'disabled' : 'enabled'} (webhooks sin límite)`);
    console.log(`💬 Twilio WhatsApp: whatsapp:+14155238886`);
    console.log('Hub endpoint ready: GET /api/hub/imagenes');
    console.log('✅ Webhook MP: POST/GET /api/webhooks/mercadopago');
    console.log('✅ Webhook Stripe: POST/GET /api/webhooks/stripe');
    console.log('✅ Retorno Stripe (solo lectura): GET/POST /api/pago-exitoso-stripe');
    console.log('✅ Retorno MP JSON: GET/POST /api/pago-exitoso');
    console.log('✅ QR reserva: POST /api/reservas/:id/generar-qr');
    console.log('✅ Perfil público: GET /api/jugador/perfil-publico/:userId');
    console.log('✅ Torneos: GET /api/torneos/finalizados');
    console.log('✅ Push: POST /api/push-tokens, POST /api/push/send');
    console.log('✅ XP ARENA: GET /api/xp/mi-xp, GET /api/xp/historial');
    console.log('✅ Partidos: POST /api/partidos/:id/resultado');
    console.log('✅ Arena: POST /api/arena/logros');
    console.log('✅ Logros premios: GET /api/logros-premios/:sede_id, POST/DELETE /api/admin/logros-premios');
    console.log('✅ Ligas premios: GET /api/ligas-premios/:sede_id, POST/DELETE /api/admin/ligas-premios');
    console.log('✅ Rangos ARENA: GET /api/rangos/mi-rango');
    console.log('✅ Admin: GET /api/admin/reservas-diagnostico');
    console.log('✅ Admin/cron: POST /api/reservas/cleanup-expired-holds');
    console.log('✅ Extras sede: GET /api/sedes/:id/extras-admin + CRUD /api/sedes/:id/extras');
    console.log('✅ Torneo interés: POST/DELETE /api/sedes/:id/torneo-interes, GET /api/admin/sedes/:id/torneo-interes');
    console.log('✅ Lista espera general: POST/DELETE/GET check /api/lista-espera-general, GET /api/admin/lista-espera-general/:sede_id');
    console.log(`✅ Fotos sede: POST /api/sedes/:id/fotos (máx. ${20} por sede)`);
    console.log('✅ Scoreboard: POST/GET /api/scoreboard/partidos, WebSocket scoreboard:update');
    console.log('✅ Torneos: POST /api/torneos/:id/generar-scoreboards');
  });
})();
