import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import Stripe from 'stripe';
import cron from 'node-cron';
import { createEquiposUsuarioRouter } from './routes/equipos.js';
import { createHubRouter } from './routes/hub.js';
import { createMembresiasRouter } from './routes/membresias.js';
import { createPartidosAbiertosRouter, createPartidosRouter } from './routes/partidos.js';
import { createClasesRouter } from './routes/clases.js';

dotenv.config();

const app = express();
const PORT = 3001;

// CORS
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:8081',
    'exp://192.168.0.19:8081',
    'https://expo.dev',
    'https://padbol-match.netlify.app',
    'https://padbol-match-9abn.vercel.app'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json());

// Supabase (desde .env)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  SUPABASE_SERVICE_ROLE_KEY no está configurado — supabaseAdmin usa SUPABASE_KEY');
}

// Mercado Pago
if (!process.env.MP_ACCESS_TOKEN) {
  console.warn('⚠️  MP_ACCESS_TOKEN no está configurado — los pagos fallarán en producción');
}
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || '',
});

const stripeClient = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

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
  const currency = String(moneda || 'USD').toLowerCase();
  const toCents = (amount) => Math.round(Number(amount) * 100);

  const line_items = [{
    price_data: {
      currency,
      product_data: { name: titulo },
      unit_amount: toCents(pricing?.base ?? 0),
    },
    quantity: 1,
  }];

  for (const extra of normalizePaymentExtras(extras)) {
    line_items.push({
      price_data: {
        currency: String(extra.moneda || moneda || 'USD').toLowerCase(),
        product_data: { name: extra.nombre },
        unit_amount: toCents(extra.precio),
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
        unit_amount: toCents(fee),
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

  const { data: sedeRow } = await supabase
    .from('sedes')
    .select('mp_access_token')
    .eq('id', sedeId)
    .maybeSingle();

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
  const externalReference = reservaData ? JSON.stringify(reservaData) : '';
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
      base: reserva.precio_base ?? reserva.precio,
      fee: reserva.platform_fee ?? 0,
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
  console.log(`✓ WhatsApp enviado a ${to}`);
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

function mapMisReservaRow(row) {
  const sedeNombre = row.sedes?.nombre ?? row.sede ?? null;

  return {
    id: row.id,
    sede_nombre: sedeNombre,
    sede: sedeNombre,
    sede_id: null,
    fecha: row.fecha,
    hora: row.hora,
    duracion_minutos: row.duracion_minutos ?? null,
    cancha: row.cancha ?? null,
    estado: row.estado ?? null,
    monto: row.monto ?? row.precio ?? null,
    precio: row.precio ?? row.monto ?? null,
    moneda: row.moneda ?? 'ARS',
    checkin_realizado: row.checkin_realizado ?? false,
    created_at: row.created_at ?? null,
  };
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
  return reserva.sede === sedeRow.nombre || String(reserva.sede) === String(sedeId);
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
  if (reserva.supabase_user_id && reserva.supabase_user_id === user.id) return true;
  if (qrUserId && qrUserId === user.id) return true;
  return false;
}

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
    
    console.log('SEDES RESPONSE:', data);
    res.json(data || []);
  } catch (err) {
    console.error('❌ Error GET /api/sedes:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sedes/:id — Single sede with full details (JWT required)
app.get('/api/sedes/:id', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const sedeId = parseInt(req.params.id, 10);
    if (Number.isNaN(sedeId)) {
      return res.status(400).json({ error: 'ID de sede inválido' });
    }

    const { data, error } = await supabase
      .from('sedes')
      .select('*')
      .eq('id', sedeId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Sede no encontrada' });
    }

    res.json(data);
  } catch (err) {
    console.error('❌ Error GET /api/sedes/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sedes/:id/extras — extras activos de la sede (JWT required)
app.get('/api/sedes/:id/extras', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const sedeId = parseInt(req.params.id, 10);
    if (Number.isNaN(sedeId)) {
      return res.status(400).json({ error: 'ID de sede inválido' });
    }

    const { data, error } = await supabase
      .from('extras')
      .select('id, nombre, precio, moneda, categoria, imagen_url, stock')
      .eq('sede_id', sedeId)
      .eq('activo', true)
      .order('categoria', { ascending: true })
      .order('nombre', { ascending: true });

    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error('❌ Error GET /api/sedes/:id/extras:', err.message);
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
    const {
      sede,
      sede_id: sedeIdBody,
      fecha,
      hora,
      cancha,
      nombre,
      email,
      whatsapp,
      telefono,
      nivel,
      nivel_partido,
      precio,
      duracion_minutos,
      user_id: userIdBody,
      modo_partido: modoPartidoRaw,
      estado,
    } = req.body;

    const modoPartido = modoPartidoRaw === true || modoPartidoRaw === 'true';

    let authUser = null;
    if (modoPartido || userIdBody) {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }
      authUser = user;
    }

    const contactEmail = email ?? authUser?.email;
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
    let sedeId = sedeIdBody != null ? parseInt(sedeIdBody, 10) : null;

    if (sedeId && !sedeNombre) {
      const { data: sedeRow } = await supabaseAdmin
        .from('sedes')
        .select('nombre')
        .eq('id', sedeId)
        .maybeSingle();
      sedeNombre = sedeRow?.nombre ?? null;
    }

    if (!sedeId && sedeNombre) {
      const { data: sedeRow } = await supabaseAdmin
        .from('sedes')
        .select('id')
        .eq('nombre', sedeNombre)
        .maybeSingle();
      sedeId = sedeRow?.id ?? null;
    }

    if (!sedeNombre) {
      return res.status(400).json({ error: 'Sede no encontrada' });
    }

    const canchaNum = cancha != null ? parseInt(cancha, 10) : null;
    if (canchaNum == null || Number.isNaN(canchaNum)) {
      return res.status(400).json({ error: 'Falta cancha válida' });
    }
    const canchaValue = normalizeReservaCancha(canchaNum);

    if (!modoPartido && !userIdBody && !contactWhatsapp) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const conflictQuery = supabaseAdmin
      .from('reservas')
      .select('id')
      .eq('sede', sedeNombre)
      .eq('fecha', fecha)
      .eq('hora', hora)
      .eq('cancha', canchaValue)
      .in('estado', ['prereserva', 'confirmada', 'reservada', 'pendiente']);

    const { data: existentes, error: errCheck } = await conflictQuery;
    if (errCheck) throw errCheck;

    if (existentes && existentes.length > 0) {
      return res.status(409).json({ error: 'Este horario ya está reservado' });
    }

    const insertRow = {
      sede: sedeNombre,
      fecha,
      hora,
      cancha: canchaValue,
      nombre: contactNombre,
      email: contactEmail,
      telefono: contactWhatsapp,
      whatsapp: contactWhatsapp,
      nivel: nivel_partido ?? nivel ?? 'Principiante',
      precio: precio != null ? parseInt(precio, 10) : 0,
      estado: modoPartido ? 'prereserva' : (estado || 'confirmada'),
      pago_estado: modoPartido ? 'pendiente' : undefined,
      duracion_minutos: duracion_minutos != null ? parseInt(duracion_minutos, 10) : null,
      user_id: authUser?.id ?? userIdBody ?? null,
      monto: precio != null ? parseInt(precio, 10) : null,
    };

    if (!modoPartido) {
      delete insertRow.pago_estado;
    }

    const { data: reservaRows, error: insertErr } = await supabaseAdmin
      .from('reservas')
      .insert([insertRow])
      .select('*');

    if (insertErr) throw insertErr;

    const reserva = reservaRows?.[0];
    if (!reserva) {
      throw new Error('No se pudo crear la reserva');
    }

    console.log('✓ Reserva creada:', reserva.id);

    let partidoId = null;
    let deadlineCancel = null;
    if (modoPartido) {
      if (!authUser) {
        return res.status(401).json({ error: 'Autenticación requerida para crear partido' });
      }
      if (!sedeId) {
        return res.status(400).json({ error: 'sede_id requerido para partido abierto' });
      }

      const nivelPartido = nivel_partido ?? nivel ?? 'Intermedio';
      deadlineCancel = computePartidoDeadlineCancel(fecha, hora);

      const { data: partido, error: partidoErr } = await supabaseAdmin
        .from('partidos_abiertos')
        .insert([{
          reserva_id: reserva.id,
          sede_id: sedeId,
          host_user_id: authUser.id,
          host_email: authUser.email ?? contactEmail,
          fecha,
          hora,
          nivel: nivelPartido,
          estado: 'esperando_jugadores',
          jugadores_actuales: 1,
          jugadores_necesarios: 4,
          max_jugadores: 4,
          deadline_cancel: deadlineCancel,
        }])
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

    if (!modoPartido) {
      const { data: sedeRow } = await supabase
        .from('sedes')
        .select('direccion')
        .eq('nombre', sedeNombre)
        .maybeSingle();

      if (contactWhatsapp) {
        sendWhatsAppConfirmation(contactWhatsapp, {
          sede: sedeNombre,
          fecha,
          hora,
          cancha: canchaNum,
          direccion: sedeRow?.direccion,
        }).catch((err) => console.warn('⚠️ WhatsApp no enviado:', err.message));
      }
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
    console.error('❌ Error POST reserva:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reservas/:id/confirmar — confirm prereserva after creator payment
app.post('/api/reservas/:id/confirmar', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
    }

    const reservaId = parseInt(req.params.id, 10);
    if (Number.isNaN(reservaId)) {
      return res.status(400).json({ error: 'ID de reserva inválido' });
    }

    const { data: reserva, error: fetchErr } = await supabaseAdmin
      .from('reservas')
      .select('*')
      .eq('id', reservaId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!reserva) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    if (reserva.user_id && reserva.user_id !== user.id) {
      return res.status(403).json({ error: 'No tenés permiso para confirmar esta reserva' });
    }

    if (reserva.estado !== 'prereserva') {
      return res.status(400).json({ error: 'La reserva no está pendiente de confirmación' });
    }

    const { data: updatedRows, error: updateErr } = await supabaseAdmin
      .from('reservas')
      .update({
        estado: 'confirmada',
        pago_estado: 'pagado',
      })
      .eq('id', reservaId)
      .select('*');

    if (updateErr) throw updateErr;

    const updated = updatedRows?.[0];
    const mappedReserva = mapMisReservaRow({ ...updated, sedes: { nombre: updated.sede } });

    if (updated?.whatsapp) {
      const { data: sedeRow } = await supabase
        .from('sedes')
        .select('direccion')
        .eq('nombre', updated.sede)
        .maybeSingle();

      sendWhatsAppConfirmation(updated.whatsapp, {
        sede: updated.sede,
        fecha: updated.fecha,
        hora: updated.hora,
        cancha: updated.cancha,
        direccion: sedeRow?.direccion,
      }).catch((err) => console.warn('⚠️ WhatsApp no enviado:', err.message));
    }

    console.log(`✓ POST /api/reservas/${reservaId}/confirmar — confirmada, pago_estado=pagado`);
    res.json({ reserva: mappedReserva, success: true });
  } catch (err) {
    console.error('❌ Error POST /api/reservas/:id/confirmar:', err.message);
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

// GET /api/reservas/mis-reservas — authenticated user's reservations (JWT required)
app.get('/api/reservas/mis-reservas', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const filters = buildUserEmailOrIdFilters(user, {
      userIdFields: ['user_id', 'supabase_user_id'],
    });

    const { data, error } = await supabaseAdmin
      .from('reservas')
      .select('*')
      .or(filters.join(','))
      .order('fecha', { ascending: false })
      .order('hora', { ascending: false });

    if (error) throw error;

    res.json((data || []).map(mapMisReservaRow));
  } catch (err) {
    console.error('❌ Error GET /api/reservas/mis-reservas:', err.message);
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
    if (cancha   !== undefined) updates.cancha   = cancha !== null ? normalizeReservaCancha(cancha) : null;
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

// POST /api/torneos/confirmar-inscripcion — marca inscripción del equipo como confirmada (tras pago MP)
app.post('/api/torneos/confirmar-inscripcion', async (req, res) => {
  try {
    const { equipo_id, torneo_id } = req.body || {};
    const eid = parseInt(String(equipo_id), 10);
    const tid = parseInt(String(torneo_id), 10);
    if (!eid || !tid) {
      return res.status(400).json({ error: 'equipo_id y torneo_id son requeridos' });
    }

    const { data: eq, error: errEq } = await supabase
      .from('equipos')
      .select('id, torneo_id, inscripcion_estado')
      .eq('id', eid)
      .maybeSingle();

    if (errEq) throw errEq;
    if (!eq) return res.status(404).json({ error: 'Equipo no encontrado' });
    if (Number(eq.torneo_id) !== tid) {
      return res.status(400).json({ error: 'El equipo no pertenece a ese torneo' });
    }

    if (String(eq.inscripcion_estado || '').toLowerCase() === 'confirmado') {
      return res.json({ ok: true, already: true });
    }

    const { error: errUp } = await supabase
      .from('equipos')
      .update({ inscripcion_estado: 'confirmado' })
      .eq('id', eid);

    if (errUp) throw errUp;
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ POST /api/torneos/confirmar-inscripcion:', err.message);
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

// ===== PARTIDOS ABIERTOS =====
app.use('/api/partidos', createPartidosRouter({
  supabase,
  supabaseAdmin,
  getAuthenticatedUser,
  computePartidoDeadlineCancel,
  triggerPartidoCreatorPayment,
}));
app.use('/api/partidos-abiertos', createPartidosAbiertosRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/clases', createClasesRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/membresias', createMembresiasRouter({ supabaseAdmin, getAuthenticatedUser }));
app.use('/api/equipos', createEquiposUsuarioRouter({ supabaseAdmin, getAuthenticatedUser }));

// ===== HUB (action card images — public GET /api/hub/imagenes) =====
app.use('/api/hub', createHubRouter({ supabaseAdmin }));
console.log('Hub router registered at /api/hub (GET /api/hub/imagenes)');

// ===== PARTIDOS (torneos — rutas legacy) =====
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
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cancelar-reserva — Cancellation with optional credit
app.post('/api/cancelar-reserva', async (req, res) => {
  try {
    const { reservaId, email } = req.body;
    if (!reservaId || !email) {
      return res.status(400).json({ error: 'Faltan campos: reservaId, email' });
    }

    // Fetch the reservation and verify ownership
    const { data: reserva, error: fetchErr } = await supabase
      .from('reservas')
      .select('*')
      .eq('id', reservaId)
      .eq('email', email)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada o no pertenece a este usuario' });
    if (reserva.estado === 'cancelada') return res.status(409).json({ error: 'La reserva ya está cancelada' });

    // Check if reservation is more than 24h away (Argentina UTC-3)
    const reservaDt = new Date(`${reserva.fecha}T${reserva.hora}:00-03:00`);
    const nowAR     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
    const horasHasta = (reservaDt - nowAR) / (1000 * 60 * 60);
    const eligibleForCredit = horasHasta > 24;

    // Mark as cancelled
    const { error: updateErr } = await supabase
      .from('reservas')
      .update({ estado: 'cancelada' })
      .eq('id', reservaId);
    if (updateErr) throw updateErr;

    // Credit if eligible
    let credito = null;
    if (eligibleForCredit && reserva.precio > 0) {
      // Look up sede_id by name
      const { data: sedeRow } = await supabase
        .from('sedes')
        .select('id')
        .eq('nombre', reserva.sede)
        .maybeSingle();

      const venceAt = new Date();
      venceAt.setDate(venceAt.getDate() + 30);

      const { data: creditData, error: creditErr } = await supabase
        .from('creditos')
        .insert([{
          email,
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
    res.json({ success: true, eligibleForCredit: credito !== null, credito });
  } catch (err) {
    console.error('❌ Error POST /api/cancelar-reserva:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/creditos/:email — active (unused, non-expired) credit balance
app.get('/api/creditos/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const now   = new Date().toISOString();

    const { data, error } = await supabase
      .from('creditos')
      .select('id, monto, sede_id, created_at, vence_at')
      .eq('email', email)
      .eq('usado', false)
      .gt('vence_at', now)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    const total = (data || []).reduce((sum, c) => sum + Number(c.monto), 0);
    console.log(`✓ GET creditos ${email} — total: ${total} (${(data || []).length} registros)`);
    res.json({ total, creditos: data || [] });
  } catch (err) {
    console.error('❌ Error GET /api/creditos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crear-preferencia — Mercado Pago Checkout Pro
app.post('/api/crear-preferencia', async (req, res) => {
  try {
    const {
      titulo,
      precio,
      moneda,
      sedeNombre,
      reservaData,
      sedeId,
      extras,
      pricing,
    } = req.body;
    if (!titulo || precio == null) {
      return res.status(400).json({ error: 'Faltan campos requeridos: titulo, precio' });
    }

    // Use sede-specific MP token if configured, otherwise fall back to env var
    let client = mpClient;
    if (sedeId) {
      const { data: sedeRow } = await supabase
        .from('sedes')
        .select('mp_access_token')
        .eq('id', sedeId)
        .maybeSingle();
      if (sedeRow?.mp_access_token) {
        client = new MercadoPagoConfig({ accessToken: sedeRow.mp_access_token });
      }
    }

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

    // Embed full reservation data as JSON in external_reference so
    // PagoExitoso can create the reservation after payment is approved.
    const externalReference = reservaData ? JSON.stringify(reservaData) : '';

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

    console.log(`✓ MP preferencia creada: ${response.id} | items: ${items.length} | sede: ${sedeNombre || '—'}`);
    res.json({ init_point: response.init_point, preference_id: response.id });
  } catch (err) {
    console.error('❌ Error POST /api/crear-preferencia:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crear-pago-stripe — Stripe Checkout Session
app.post('/api/crear-pago-stripe', async (req, res) => {
  try {
    if (!stripeClient) {
      return res.status(503).json({ error: 'Stripe no configurado en el servidor' });
    }

    const {
      titulo,
      precio,
      moneda,
      sedeNombre,
      reservaData,
      sedeId,
      extras,
      pricing,
      return_url: returnUrl,
      cancel_url: cancelUrl,
    } = req.body;

    if (!titulo || precio == null) {
      return res.status(400).json({ error: 'Faltan campos requeridos: titulo, precio' });
    }

    const paymentExtras = extras ?? reservaData?.extras ?? [];
    const paymentPricing = pricing ?? {
      base: reservaData?.precio_base ?? precio,
      fee: reservaData?.platform_fee ?? 0,
      extrasSubtotal: reservaData?.extras_subtotal ?? 0,
      total: precio,
    };
    const line_items = buildStripeLineItems({
      titulo,
      moneda,
      pricing: paymentPricing,
      extras: paymentExtras,
    });

    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: returnUrl || 'padbolmatch://pago-exitoso',
      cancel_url: cancelUrl || 'padbolmatch://pago-error',
      metadata: {
        sede_id: String(sedeId || ''),
        sede_nombre: sedeNombre || '',
        external_reference: reservaData ? JSON.stringify(reservaData).slice(0, 500) : '',
      },
    });

    console.log(`✓ Stripe session creada: ${session.id} | items: ${line_items.length} | sede: ${sedeNombre || '—'}`);
    res.json({
      url: session.url,
      session_url: session.url,
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error('❌ Error POST /api/crear-pago-stripe:', err.message);
    res.status(500).json({ error: err.message });
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

    const { data: reservas, error } = await supabase
      .from('reservas')
      .select('*')
      .eq('fecha', targetFecha)
      .eq('hora', targetHora)
      .eq('estado', 'confirmada')
      .eq('recordatorio_enviado', false);

    if (error) {
      console.error('❌ Cron recordatorio - error Supabase:', error.message);
      return;
    }

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

        const body =
`🎾 *¡Te esperamos en ${r.sede}!*

Tu reserva es en 1 hora:
⏰ ${r.hora}hs${sedeRow?.direccion ? `\n📍 ${sedeRow.direccion}` : ''}

Recordá llegar 10 minutos antes.
💬 Ante cualquier consulta escribinos por WhatsApp.

*PADBOL MATCH*`;

        const digits = String(r.whatsapp).replace(/\D/g, '');
        const to     = `whatsapp:+${digits}`;
        await twilioClient.messages.create({ from: TWILIO_WHATSAPP_FROM, to, body });
        console.log(`✓ Recordatorio enviado a ${to} (reserva ${r.id})`);

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

// ─── Auto-cancel incomplete partidos past deadline (every 15 min) ───────────
const PARTIDO_AUTO_CANCEL_MS = 15 * 60 * 1000;

async function runPartidoAutoCancelCron() {
  try {
    const now = new Date().toISOString();
    const { data: partidos, error } = await supabaseAdmin
      .from('partidos_abiertos')
      .select('id, reserva_id, jugadores_actuales, jugadores_necesarios, max_jugadores')
      .eq('estado', 'esperando_jugadores')
      .lte('deadline_cancel', now);

    if (error) throw error;
    if (!partidos?.length) return;

    for (const partido of partidos) {
      const needed = partido.jugadores_necesarios ?? partido.max_jugadores ?? 4;
      const current = partido.jugadores_actuales ?? 0;
      if (current >= needed) continue;

      if (partido.reserva_id) {
        await supabaseAdmin
          .from('reservas')
          .update({ estado: 'cancelada', pago_estado: 'no_aplica' })
          .eq('id', partido.reserva_id);
      }

      await supabaseAdmin
        .from('partidos_abiertos')
        .update({ estado: 'cancelado_por_tiempo' })
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
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      .select('sede')
      .eq('email', email);

    for (const reserva of reservas || []) {
      if (reserva.sede) {
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

const usuariosRouter = express.Router();

// POST /api/usuarios/push-token — Save Expo push token on jugadores_perfil
usuariosRouter.post('/push-token', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const { expo_push_token, email: bodyEmail, supabase_user_id: bodyUserId } = req.body;
    if (!expo_push_token) {
      return res.status(400).json({ error: 'expo_push_token es requerido' });
    }

    const email = bodyEmail ?? user.email ?? null;
    const supabase_user_id = bodyUserId ?? user.id ?? null;

    if (bodyEmail && bodyEmail !== user.email) {
      return res.status(403).json({ error: 'El email no coincide con el usuario autenticado' });
    }
    if (bodyUserId && bodyUserId !== user.id) {
      return res.status(403).json({ error: 'supabase_user_id no coincide con el usuario autenticado' });
    }

    const filters = [];
    if (email) filters.push(`email.eq."${String(email).replace(/"/g, '\\"')}"`);
    if (supabase_user_id) filters.push(`supabase_user_id.eq.${supabase_user_id}`);

    if (filters.length === 0) {
      return res.status(400).json({ error: 'Se requiere email o supabase_user_id' });
    }

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .update({ expo_push_token })
      .or(filters.join(','))
      .select('id');

    if (error) throw error;
    if (!data?.length) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    console.log(`✓ POST /api/usuarios/push-token — token guardado para ${email ?? supabase_user_id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error POST /api/usuarios/push-token:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/usuarios/perfil — Current user profile from jugadores_perfil
usuariosRouter.get('/perfil', async (req, res) => {
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
      .select('*')
      .or(filters.join(','))
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    res.json({
      nombre: data.nombre ?? '',
      telefono: data.telefono ?? '',
      nivel: data.nivel ?? '',
      lateralidad: data.lateralidad ?? data.pierna_habil ?? '',
      pais: data.pais ?? '',
      email: data.email ?? user.email ?? '',
      foto_url: data.foto_url ?? null,
    });
  } catch (err) {
    console.error('❌ Error GET /api/usuarios/perfil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/usuarios/perfil — Update jugadores_perfil for authenticated user
usuariosRouter.put('/perfil', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const email = user.email;
    if (!email) {
      return res.status(400).json({ error: 'Usuario sin email' });
    }

    const { nombre, telefono, nivel, lateralidad, pais } = req.body;

    const updatePayload = {
      nombre: nombre ?? null,
      telefono: telefono ?? null,
      nivel: nivel ?? null,
      lateralidad: lateralidad ?? null,
      pais: pais ?? null,
    };

    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .update(updatePayload)
      .eq('email', email)
      .select('nombre, telefono, nivel, lateralidad, pierna_habil, pais, email, foto_url');

    if (error) throw error;
    if (!data?.length) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    const perfil = data[0];
    console.log(`✓ PUT /api/usuarios/perfil — perfil actualizado para ${email}`);
    res.json({
      nombre: perfil.nombre ?? '',
      telefono: perfil.telefono ?? '',
      nivel: perfil.nivel ?? '',
      lateralidad: perfil.lateralidad ?? perfil.pierna_habil ?? '',
      pais: perfil.pais ?? '',
      email: perfil.email ?? email,
      foto_url: perfil.foto_url ?? null,
    });
  } catch (err) {
    console.error('❌ Error PUT /api/usuarios/perfil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

    console.log(`✓ POST /api/usuarios/foto-perfil — foto guardada para ${email}`);
    res.json({ foto_url });
  } catch (err) {
    console.error('❌ Error POST /api/usuarios/foto-perfil:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/usuarios/perfil-publico/:identifier — Public player profile (JWT required)
usuariosRouter.get('/perfil-publico/:identifier', async (req, res) => {
  try {
    const { user, status, error: authError } = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(status).json({ error: authError });
    }

    const identifier = decodeURIComponent(req.params.identifier ?? '').trim();
    if (!identifier) {
      return res.status(400).json({ error: 'Identificador de jugador requerido' });
    }

    let perfilQuery = supabaseAdmin
      .from('jugadores_perfil')
      .select('id, email, supabase_user_id, nombre, pais, ciudad, nivel, sede_id, foto_url');

    if (identifier.includes('@')) {
      perfilQuery = perfilQuery.eq('email', identifier);
    } else if (UUID_REGEX.test(identifier)) {
      perfilQuery = perfilQuery.eq('supabase_user_id', identifier);
    } else {
      const numericId = parseInt(identifier, 10);
      if (Number.isNaN(numericId)) {
        return res.status(400).json({ error: 'Identificador de jugador inválido' });
      }
      perfilQuery = perfilQuery.eq('id', numericId);
    }

    const { data: perfil, error: perfilErr } = await perfilQuery.maybeSingle();
    if (perfilErr) throw perfilErr;
    if (!perfil) {
      return res.status(404).json({ error: 'Perfil de jugador no encontrado' });
    }

    const [partidosJugados, rankingStats, sedesHabituales] = await Promise.all([
      countPartidosJugados({
        email: perfil.email,
        supabaseUserId: perfil.supabase_user_id,
      }),
      getRankingEntryForEmail(perfil.email),
      getSedesHabituales({
        email: perfil.email,
        supabaseUserId: perfil.supabase_user_id,
        primarySedeId: perfil.sede_id,
      }),
    ]);

    let ciudad = perfil.ciudad ?? '';
    let pais = perfil.pais ?? '';

    if (perfil.sede_id != null) {
      const { data: sedePrincipal } = await supabaseAdmin
        .from('sedes')
        .select('ciudad, provincia, pais')
        .eq('id', perfil.sede_id)
        .maybeSingle();

      if (sedePrincipal) {
        ciudad = ciudad || sedePrincipal.ciudad || sedePrincipal.provincia || '';
        pais = pais || sedePrincipal.pais || '';
      }
    }

    if (!ciudad && sedesHabituales.length > 0) {
      ciudad = sedesHabituales[0].ciudad || sedesHabituales[0].provincia || '';
      pais = pais || sedesHabituales[0].pais || '';
    }

    res.json({
      id: perfil.id,
      email: perfil.email ?? null,
      supabase_user_id: perfil.supabase_user_id ?? null,
      nombre: perfil.nombre ?? '',
      pais,
      ciudad,
      nivel: perfil.nivel ?? '',
      categoria_ranking: rankingStats?.categoria_ranking ?? perfil.nivel ?? null,
      foto_url: perfil.foto_url ?? null,
      estadisticas: {
        partidos_jugados: partidosJugados,
        torneos: rankingStats?.torneos ?? 0,
        ranking_position: rankingStats?.ranking_position ?? null,
        puntos_total: rankingStats?.puntos_total ?? 0,
      },
      sedes_habituales: sedesHabituales.map((sede) => ({
        id: sede.id,
        nombre: sede.nombre,
        ciudad: sede.ciudad ?? null,
        provincia: sede.provincia ?? null,
        pais: sede.pais ?? null,
      })),
    });
  } catch (err) {
    console.error('❌ Error GET /api/usuarios/perfil-publico/:identifier:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/usuarios', usuariosRouter);

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

    const allowedStates = ['confirmada', 'pendiente'];
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
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/checkin', checkinRouter);

app.listen(PORT, () => {
  console.log(`🚀 Padbol Match API running on port ${PORT}`);
  console.log(`📊 Supabase: ${SUPABASE_URL}`);
  console.log(`💬 Twilio WhatsApp: whatsapp:+14155238886`);
  console.log('Hub endpoint ready: GET /api/hub/imagenes');
});
