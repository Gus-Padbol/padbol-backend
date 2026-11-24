import {createQaGuardedPool,mountSedeQaDiagnostic,mountQaLegacyAdmission} from '../lib/sedeQaRuntimeGuard.js';
import { pickPublicSedeWithPaymentStatus, redactSedePaymentValues } from '../utils/sedePublicSelect.js';
import { buildSedeReleaseInsert } from '../lib/sedeReleaseContract.js';
import { resolveStoredRoleForVerifiedUser } from '../lib/roleIdentity.js';
import { DateTime } from 'luxon';
import { sendMakeEvent } from '../make/sendMakeEvent.js';
import { createAcknowledgedMakeTransport } from '../lib/sedeMakeTransport.js';
import { mountSedeApprovalRecoveryRoutes } from './sedeApprovalRecovery.js';
import { rejectPendingSede } from '../lib/sedePendingRejection.js';

import { createGenerateAdminInviteMagicLink } from '../lib/adminInviteMagicLink.js';
import { notifyMakeAdminInviteWebhook } from '../make/sendMakeAdminInviteWebhook.js';
import { buildAdminRoleGeography } from '../lib/adminTerritorialScope.js';
import { MAGIC_INVITE_ROLES } from '../lib/adminInviteMagicLink.js';
import { assertInvitacionWebhookSecret } from '../lib/adminInviteMagicLink.js';
import { parseInvitacionAdminWebhookBody } from '../lib/adminInviteMagicLink.js';
import crypto from 'crypto';
import twilio from 'twilio';
import { strictSuperAdminRole } from '../lib/fipaDocumentLibrary.js';
import { registerAdminOrganizationsRoutes } from '../lib/adminOrganizations.js';
import { registerSedeIncentiveRoutes } from '../lib/sedeIncentivesV4.js';
import {
  commitDirectSeat, cancelDirectOperation, directOperationDigest, isDirectDbUnavailable,
  normalizeOperationKey, prepareDirectOperation, preflightDirectRoleTarget, readDirectOperation,
  requireDirectSuperAdmin,
} from '../lib/sedeDirectOperations.js';

// Ported from the validated local release. Mounted into the existing server; no second runtime.
export function mountCommercialReleaseRoutes(app, { supabaseAdmin, runtime, authUserFromBearer, assertSuperAdminReq, adminListScopeFromRequest, sedesPermitidasPorScope, pgPool = null, sedeApprovalRecoveryEnabled = false }) {
const supabase = supabaseAdmin;
const isSuperAdminApi = (_email, role) => role === "super_admin";


const TZ_SEDE_DEFAULT = 'America/Argentina/Buenos_Aires';

function normalizePaisKeyReserva(pais) {
  return String(pais || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeCiudadKeyReserva(ciudad) {
  return String(ciudad || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeSedeTimezone(raw) {
  const s = String(raw || '').trim();
  if (!s) return TZ_SEDE_DEFAULT;
  const probe = DateTime.now().setZone(s);
  return probe.isValid ? s : TZ_SEDE_DEFAULT;
}

function inferTimezoneFromCiudadPais(ciudad, pais) {
  const c = normalizeCiudadKeyReserva(ciudad);
  const p = normalizePaisKeyReserva(pais);
  if (c === 'miami') return 'America/New_York';
  if (c === 'madrid') return 'Europe/Madrid';
  if (p.includes('argentina')) return TZ_SEDE_DEFAULT;
  return TZ_SEDE_DEFAULT;
}

async function fetchUserRoleRow(user) {
  return resolveStoredRoleForVerifiedUser(supabaseAdmin, user);
}

function normalizeMetodoPago(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'stripe') return 'stripe';
  if (v === 'manual') return 'manual';
  if (v === 'efectivo') return 'efectivo';
  return 'mercadopago';
}

async function assertUsuarioPuedeAdministrarSede(req, sedeIdNum) {
  const scope = await adminListScopeFromRequest(req);
  if (!scope) {
    const e = new Error('No autorizado');
    e.status = 401;
    throw e;
  }
  if (scope.superA) return scope;
  const sid = Number(sedeIdNum);
  if (!Number.isFinite(sid)) {
    const e = new Error('ID de sede inválido');
    e.status = 400;
    throw e;
  }
  const allowed = await sedesPermitidasPorScope(scope);
  const ok = (allowed.sedes || []).some((s) => Number(s.id) === sid);
  if (!ok) {
    const e = new Error('No tienes permiso para esta sede');
    e.status = 403;
    throw e;
  }
  return scope;
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://padbol-match.netlify.app';

const generateAdminInviteMagicLink = createGenerateAdminInviteMagicLink({
  supabase,
  getFrontendUrl: () => FRONTEND_URL,
});

const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;

const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;

const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function sendTwilioMessage(message) {
  if (!runtime.outboundDeliveryEnabled) return { disabled: true };
  return twilioClient.messages.create(message);
}

function normalizePhoneToE164ForTwilioWhatsApp(raw) {
  const rawStr = String(raw || '').trim();
  if (!rawStr) return null;
  const digits = rawStr.replace(/\D/g, '');
  if (!digits) return null;
  const DEFAULT_CC = String(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '54').replace(/\D/g, '') || '54';

  if (rawStr.startsWith('+')) {
    return `whatsapp:+${digits}`;
  }
  if (digits.startsWith(DEFAULT_CC) && digits.length >= DEFAULT_CC.length + 8) {
    return `whatsapp:+${digits}`;
  }
  if (DEFAULT_CC === '54' && digits.length === 10) {
    return `whatsapp:+${DEFAULT_CC}9${digits}`;
  }
  return `whatsapp:+${DEFAULT_CC}${digits}`;
}

function resolveSuperAdminNotifyWhatsAppTo() {
  const raw = String(process.env.SUPER_ADMIN_NOTIFY_WHATSAPP || '').trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('whatsapp:')) return raw;
  return normalizePhoneToE164ForTwilioWhatsApp(raw);
}

function parseLatLngFromMapsUrl(rawUrl) {
  const src = String(rawUrl || '').trim();
  if (!src) return { latitud: null, longitud: null };
  const directMatch = src.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (directMatch) {
    return { latitud: Number(directMatch[1]), longitud: Number(directMatch[2]) };
  }
  try {
    const u = new URL(src);
    const q = u.searchParams.get('q') || u.searchParams.get('ll') || '';
    const qm = q.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (qm) return { latitud: Number(qm[1]), longitud: Number(qm[2]) };
    const at = src.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (at) return { latitud: Number(at[1]), longitud: Number(at[2]) };
  } catch {
    /* ignore malformed URLs */
  }
  return { latitud: null, longitud: null };
}

async function fetchPlanesPricingActivos(client = supabase) {
  const { data, error } = await client
    .from('plan_pricing')
    .select('*')
    .eq('activo', true)
    .order('canchas_min', { ascending: true });
  if (error) throw error;
  return data || [];
}

app.get('/api/plan-pricing', async (req, res) => {
  try {
    const rows = await fetchPlanesPricingActivos();
    res.json(rows);
  } catch (err) {
    console.error('❌ GET /api/plan-pricing:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.get('/api/registro/email-perfil-libre', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.email || !user.id) return res.status(401).json({ error: 'No autorizado' });
    const email = String(user.email).trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Sin email en la sesión' });
    const { data, error } = await supabase
      .from('jugadores_perfil')
      .select('id')
      .ilike('email', email)
      .neq('user_id', user.id)
      .limit(1);
    if (error) throw error;
    const conflicto = Array.isArray(data) && data.length > 0;
    res.json({ disponible: !conflicto });
  } catch (err) {
    console.error('❌ GET /api/registro/email-perfil-libre:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.get('/api/registro/whatsapp-disponible', async (req, res) => {
  try {
    const whatsapp = String(req.query.whatsapp || '').trim();
    if (!whatsapp) return res.status(400).json({ error: 'whatsapp requerido' });
    let excludeUserId = null;
    try {
      const user = await authUserFromBearer(req);
      if (user?.id) excludeUserId = user.id;
    } catch {
      /* registro sin sesión */
    }
    const disponible = await whatsappDisponibleEnJugadoresPerfil(supabase, whatsapp, excludeUserId);
    res.json({ disponible });
  } catch (err) {
    console.error('❌ GET /api/registro/whatsapp-disponible:', err.message);
    const friendly = mensajeErrorJugadoresPerfilDuplicado(err);
    res.status(500).json({ error: friendly || 'No se pudo validar el teléfono. Intenta de nuevo.' });
  }
});

app.patch('/api/registro/completar-perfil', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.id) return res.status(401).json({ error: 'Se requiere sesión' });
    const email = String(user.email || '').trim().toLowerCase();
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (b.genero != null) patch.genero = String(b.genero).trim().toLowerCase();
    if (b.whatsapp != null) patch.whatsapp = String(b.whatsapp).trim();
    if (Array.isArray(b.deportes_preferidos)) patch.deportes_preferidos = b.deportes_preferidos;
    if (b.nombre != null) patch.nombre = String(b.nombre).trim();
    if (b.apellido != null) patch.apellido = String(b.apellido).trim() || null;
    if (patch.whatsapp) {
      const ok = await whatsappDisponibleEnJugadoresPerfil(supabase, patch.whatsapp, user.id);
      if (!ok) {
        return res.status(409).json({ error: 'Este número de teléfono ya está registrado en otra cuenta' });
      }
    }
    const data = await upsertJugadoresPerfilPorUserId(supabase, {
      userId: user.id,
      email,
      patch,
    });
    res.json({ ok: true, perfil: data });
  } catch (err) {
    console.error('❌ PATCH /api/registro/completar-perfil:', err.message);
    const friendly = mensajeErrorJugadoresPerfilDuplicado(err);
    res.status(friendly ? 409 : 500).json({ error: friendly || err.message || 'No se pudo guardar el perfil.' });
  }
});

app.patch('/api/plan-pricing/:id', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.email) return res.status(401).json({ error: 'No autorizado' });
    const rowRole = await fetchUserRoleRow(user);
    if (!isSuperAdminApi(user.email, rowRole?.role)) {
      return res.status(403).json({ error: 'Solo super admin' });
    }
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
    const raw = req.body?.precio_usd;
    const precio = raw != null && raw !== '' ? Number(String(raw).replace(',', '.')) : NaN;
    if (!Number.isFinite(precio) || precio < 0) {
      return res.status(400).json({ error: 'precio_usd inválido' });
    }
    const rounded = Math.round(precio * 100) / 100;
    const { data, error } = await supabase
      .from('plan_pricing')
      .update({ precio_usd: rounded })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Plan no encontrado' });
    res.json({ plan: data });
  } catch (err) {
    console.error('❌ PATCH /api/plan-pricing/:id:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.post('/api/sedes', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.email) return res.status(401).json({ error: 'No autorizado' });
    const rowRole = await fetchUserRoleRow(user);
    const role = rowRole?.role || null;
    if (!isSuperAdminApi(user.email, role)) {
      return res.status(403).json({ error: 'Solo super admin' });
    }

    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    const ciudad = String(b.ciudad || '').trim();
    const pais = String(b.pais || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Nombre de la sede obligatorio' });
    if (!ciudad) return res.status(400).json({ error: 'Ciudad obligatoria' });
    if (!pais) return res.status(400).json({ error: 'País obligatorio' });

    const latitudBody = b.latitud != null && String(b.latitud).trim() !== '' ? Number(b.latitud) : null;
    const longitudBody = b.longitud != null && String(b.longitud).trim() !== '' ? Number(b.longitud) : null;
    const mapsParsed = parseLatLngFromMapsUrl(b.google_maps_url || b.maps_url || b.googleMapsUrl || '');
    const latitud = Number.isFinite(latitudBody) ? latitudBody : mapsParsed.latitud;
    const longitud = Number.isFinite(longitudBody) ? longitudBody : mapsParsed.longitud;

    const precioTurno = b.precio_turno != null && b.precio_turno !== '' ? Number(b.precio_turno) : null;
    const canchasActivas = b.canchas_activas != null && b.canchas_activas !== '' ? parseInt(String(b.canchas_activas), 10) : null;
    const cantidadCanchasTotal =
      b.cantidad_canchas != null && String(b.cantidad_canchas).trim() !== ''
        ? parseInt(String(b.cantidad_canchas), 10)
        : null;
    const skipAutogenCanchas = Boolean(b.skip_autogen_canchas);
    const emailContacto = String(b.email_contacto || '').trim();
    const telefonoBody = String(b.telefono || b.whatsapp || '').trim();
    const tipoSedeBody = String(b.tipo_sede || '').trim().toLowerCase();
    const esSedeTorneoBody = tipoSedeBody === 'torneo';
    if (!esSedeTorneoBody && !emailContacto) return res.status(400).json({ error: 'Email de contacto obligatorio' });
    if (!esSedeTorneoBody && !telefonoBody) return res.status(400).json({ error: 'Teléfono / WhatsApp obligatorio' });

    const timezoneSede = normalizeSedeTimezone(
      b.timezone != null && String(b.timezone).trim()
        ? String(b.timezone).trim()
        : inferTimezoneFromCiudadPais(ciudad, pais),
    );

    const payload = {
      nombre,
      pais,
      provincia: String(b.provincia || b.estado || '').trim() || null,
      ciudad,
      timezone: timezoneSede,
      direccion: String(b.direccion || '').trim() || null,
      email_contacto: emailContacto,
      telefono: telefonoBody,
      horario_apertura: String(b.horario_apertura || '').trim() || null,
      horario_cierre: String(b.horario_cierre || '').trim() || null,
      precio_turno: Number.isFinite(precioTurno) ? precioTurno : null,
      moneda: String(b.moneda || 'ARS').trim().toUpperCase() || 'ARS',
      metodo_pago: normalizeMetodoPago(b.metodo_pago || 'mercadopago'),
      stripe_account_id: String(b.stripe_account_id || '').trim() || null,
      mp_access_token: String(b.mp_access_token || '').trim() || null,
      mp_public_key: String(b.mp_public_key || '').trim() || null,
      pago_manual_instrucciones: String(b.pago_manual_instrucciones || '').trim() || null,
      latitud: Number.isFinite(latitud) ? latitud : null,
      longitud: Number.isFinite(longitud) ? longitud : null,
      google_maps_url: String(b.google_maps_url || b.maps_url || '').trim() || null,
      ...(tipoSedeBody ? { tipo_sede: tipoSedeBody } : {}),
    };
    if (esSedeTorneoBody) {
      // Sede de torneo: sin datos de alquiler; el contrato los deja en null.
      payload.email_contacto = emailContacto || null;
      payload.telefono = telefonoBody || null;
      payload.horario_apertura = null;
      payload.horario_cierre = null;
      payload.precio_turno = null;
      delete payload.cantidad_canchas;
    }
    if (Number.isFinite(cantidadCanchasTotal) && cantidadCanchasTotal >= 0) {
      payload.cantidad_canchas = cantidadCanchasTotal;
    }

    const { data: created, error } = await supabase.from('sedes').insert(buildSedeReleaseInsert(payload)).select('*').single();
    if (error) throw error;

    if (!skipAutogenCanchas && Number.isFinite(canchasActivas) && canchasActivas > 0) {
      const rows = Array.from({ length: canchasActivas }, (_, idx) => ({
        sede_id: created.id,
        nombre: `Cancha ${idx + 1}`,
        estado: 'activa',
        deporte: 'padbol',
      }));
      const { error: canErr } = await supabase.from('canchas').insert(rows);
      if (canErr) {
        console.warn(`⚠️ POST /api/sedes: sede creada (${created.id}) pero canchas no insertadas:`, canErr.message);
      }
    }

    const deportesBody = Array.isArray(b.deportes)
      ? b.deportes
      : Array.isArray(b.deportes_canchas?.deportes)
        ? b.deportes_canchas.deportes
        : null;
    void sendMakeEvent('sede_creada', {
      nombre_sede: String(created?.nombre || nombre || '').trim() || null,
      pais: String(created?.pais || pais || '').trim() || null,
      ciudad: String(created?.ciudad || ciudad || '').trim() || null,
      email_contacto: String(created?.email_contacto || emailContacto || '').trim().toLowerCase() || null,
      deportes: deportesBody,
    });

    res.status(201).json(pickPublicSedeWithPaymentStatus(created));
  } catch (err) {
    console.error('❌ POST /api/sedes:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

const DEPORTES_SEDE_VALID = new Set(['padbol', 'padel', 'pickleball', 'squash', 'tenis', 'futbol_5', 'futbol_7']);

app.get('/api/sedes/:id/deportes', async (req, res) => {
  try {
    const sedeId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'ID de sede inválido' });
    await assertUsuarioPuedeAdministrarSede(req, sedeId);
    const { data, error } = await supabase
      .from('canchas_por_deporte')
      .select('id, sede_id, deporte, cantidad, activo, created_at')
      .eq('sede_id', sedeId)
      .order('deporte', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    const st = err.status || 500;
    if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
    console.error('❌ GET /api/sedes/:id/deportes:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.post('/api/sedes/:id/deportes', async (req, res) => {
  try {
    const sedeId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'ID de sede inválido' });
    await assertUsuarioPuedeAdministrarSede(req, sedeId);
    const arr = Array.isArray(req.body?.deportes) ? req.body.deportes : null;
    if (!arr || arr.length === 0) {
      return res.status(400).json({ error: 'deportes debe ser un array no vacío' });
    }
    const rows = [];
    for (const raw of arr) {
      const dep = String(raw?.deporte || '').trim().toLowerCase();
      const n = parseInt(String(raw?.cantidad ?? ''), 10);
      if (!DEPORTES_SEDE_VALID.has(dep)) {
        return res.status(400).json({ error: `Deporte no permitido: ${dep || '(vacío)'}` });
      }
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: `Cantidad inválida para ${dep}` });
      }
      if (n === 0) continue;
      rows.push({ sede_id: sedeId, deporte: dep, cantidad: n, activo: true });
    }
    if (!rows.length) {
      return res.status(400).json({ error: 'Al menos un deporte con cantidad mayor a 0' });
    }
    const { error: delErr } = await supabase.from('canchas_por_deporte').delete().eq('sede_id', sedeId);
    if (delErr) throw delErr;
    const { data: ins, error: insErr } = await supabase.from('canchas_por_deporte').insert(rows).select('*');
    if (insErr) throw insErr;
    res.status(201).json({ deportes: ins || [] });
  } catch (err) {
    const st = err.status || 500;
    if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
    console.error('❌ POST /api/sedes/:id/deportes:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});





function mensajeErrorJugadoresPerfilDuplicado(err) {
  if (!err) return null;
  const blob = [err.message, err.details, err.hint, err.constraint].filter(Boolean).join(' ').toLowerCase();
  const code = String(err.code || '');
  const isDup =
    code === '23505' || /duplicate|unique constraint|unique violation|already exists/i.test(blob);
  if (isDup) {
    if (/whatsapp|jugadores_perfil_whatsapp/i.test(blob)) {
      return 'Este número de teléfono ya está registrado en otra cuenta';
    }
    if (/email/i.test(blob)) return 'Este email ya está registrado en otra cuenta';
    return 'Ese dato ya está en uso. Verifica WhatsApp o email.';
  }
  const msg = String(err.message || '');
  if (msg.includes('formato_equipo') || String(err.code || '') === 'PGRST204') {
    return 'La columna formato_equipo no está en el esquema de Supabase. Ejecutá supabase/migrations/20260518120000_torneos_formato_equipo_reload.sql (o NOTIFY pgrst, \'reload schema\';).';
  }
  return null;
}

async function whatsappDisponibleEnJugadoresPerfil(supabaseClient, whatsappRaw, excludeUserId = null) {
  const wa = String(whatsappRaw || '').trim();
  if (!wa) return true;
  let q = supabaseClient.from('jugadores_perfil').select('id').eq('whatsapp', wa).limit(1);
  if (excludeUserId) q = q.neq('user_id', excludeUserId);
  const { data, error } = await q;
  if (error) throw error;
  return !(Array.isArray(data) && data.length > 0);
}

async function upsertJugadoresPerfilPorUserId(supabaseClient, { userId, email, patch }) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('user_id requerido');
  const em = String(email || '').trim().toLowerCase() || null;
  const row = { ...patch, user_id: uid };
  if (em) row.email = em;

  let existing = null;
  const byUid = await supabaseClient
    .from('jugadores_perfil')
    .select('id, nombre, apellido')
    .eq('user_id', uid)
    .maybeSingle();
  if (byUid.error) throw byUid.error;
  existing = byUid.data;
  if (!existing?.id && em) {
    const byEm = await supabaseClient
      .from('jugadores_perfil')
      .select('id, nombre, apellido')
      .eq('email', em)
      .maybeSingle();
    if (byEm.error) throw byEm.error;
    existing = byEm.data;
  }

  if (existing?.id) {
    const updatePayload = { ...row };
    const nombreActual = String(existing.nombre || '').trim();
    if (nombreActual && row.nombre && nombreActual !== 'Jugador') delete updatePayload.nombre;
    const { data, error } = await supabaseClient
      .from('jugadores_perfil')
      .update(updatePayload)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  let ins = await supabaseClient
    .from('jugadores_perfil')
    .upsert(row, { onConflict: 'user_id' })
    .select()
    .single();
  if (ins.error && em) {
    const m = String(ins.error.message || '').toLowerCase();
    if (m.includes('duplicate') || String(ins.error.code || '') === '23505') {
      ins = await supabaseClient
        .from('jugadores_perfil')
        .upsert(row, { onConflict: 'email' })
        .select()
        .single();
    }
  }
  if (ins.error) throw ins.error;
  return ins.data;
}

async function sendTwilioWhatsAppBodyToRaw(toRaw, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.warn('⚠️ Twilio no configurado — no se envía WhatsApp');
    return;
  }
  const raw = String(toRaw || '').trim();
  if (!raw) return;
  const to = raw.toLowerCase().startsWith('whatsapp:') ? raw : normalizePhoneToE164ForTwilioWhatsApp(raw);
  if (!to) {
    console.warn('⚠️ WhatsApp: destino no normalizable:', toRaw);
    return;
  }
  const receipt = await sendTwilioMessage({ from: TWILIO_WHATSAPP_FROM, to, body: String(body || '').trim() });
  return receipt;
}

async function fetchJugadorWhatsappPorEmail(email, { strict = false } = {}) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  const unavailable = () => Object.assign(new Error('CREATOR_PHONE_LOOKUP_UNAVAILABLE'), { safeToRetry: true });
  let result;
  try { result = await supabase.from('jugadores_perfil').select('whatsapp').eq('email', em).maybeSingle(); }
  catch { if (strict) throw unavailable(); return null; }
  if (!result || result.error || !('data' in result)) { if (strict) throw unavailable(); return null; }
  const { data } = result;
  const w = data?.whatsapp != null ? String(data.whatsapp).trim() : '';
  return w || null;
}

async function upsertUserRoleAdminClub({ email, nombre, pais, sede_id }) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return new Error('Email licenciatario vacío');
  const payload = {
    email: em,
    role: 'admin_club',
    alcance: 'sede',
    nombre: nombre || null,
    pais: pais || null,
    ciudad: null,
    provincia: null,
    sede_id,
    torneos_oficiales_habilitados: false,
  };
  const { data: ex } = await supabase.from('user_roles').select('email').eq('email', em).maybeSingle();
  if (ex?.email) {
    const { error } = await supabase
      .from('user_roles')
      .update({
        role: 'admin_club',
        alcance: 'sede',
        nombre: payload.nombre,
        pais: payload.pais,
        ciudad: null,
        provincia: null,
        sede_id: payload.sede_id,
        torneos_oficiales_habilitados: false,
      })
      .eq('email', em);
    return error || null;
  }
  const { error } = await supabase.from('user_roles').insert(payload);
  return error || null;
}

function invitacionAdminEsFlujoGeo(inv) {
  const role = String(inv?.invited_role || 'admin_club').trim().toLowerCase();
  const alc = String(inv?.invited_alcance || '').trim().toLowerCase();
  return role === 'admin_nacional' && ['pais', 'provincia', 'ciudad'].includes(alc);
}

async function upsertUserRoleFromInvitacionGeo({ email, nombre, inv }) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return new Error('Email vacío');
  const alcance = String(inv.invited_alcance || '').trim().toLowerCase();
  const pais = String(inv.pais || '').trim() || null;
  const provinciaInv = String(inv.provincia || '').trim() || null;
  const ciudadInv = String(inv.ciudad || '').trim() || null;
  try {
    buildAdminRoleGeography(alcance, inv);
  } catch (error) {
    return error;
  }

  let row;
  if (alcance === 'pais') {
    if (!pais) return new Error('País obligatorio en la invitación');
    row = {
      email: em,
      role: 'admin_nacional',
      alcance: 'pais',
      nombre: nombre || null,
      sede_id: null,
      ciudad: null,
      provincia: null,
      pais,
      torneos_oficiales_habilitados: true,
    };
  } else if (alcance === 'provincia') {
    if (!provinciaInv) return new Error('Provincia obligatoria en la invitación');
    row = {
      email: em,
      role: 'admin_nacional',
      alcance: 'provincia',
      nombre: nombre || null,
      sede_id: null,
      ciudad: null,
      provincia: provinciaInv,
      pais: pais || null,
      torneos_oficiales_habilitados: true,
    };
  } else if (alcance === 'ciudad') {
    if (!ciudadInv) return new Error('Ciudad obligatoria en la invitación');
    row = {
      email: em,
      role: 'admin_nacional',
      alcance: 'ciudad',
      nombre: nombre || null,
      sede_id: null,
      ciudad: ciudadInv,
      provincia: provinciaInv || null,
      pais: pais || null,
      torneos_oficiales_habilitados: true,
    };
  } else {
    return new Error('Tipo de invitación geográfica no válido');
  }

  const { data: ex } = await supabase.from('user_roles').select('email').eq('email', em).maybeSingle();
  if (ex?.email) {
    const { error } = await supabase.from('user_roles').update(row).eq('email', em);
    return error || null;
  }
  const { error } = await supabase.from('user_roles').insert(row);
  return error || null;
}

function randomTemporaryPassword() {
  return `Padbol#${Math.random().toString(36).slice(2, 8)}${Date.now().toString().slice(-4)}`;
}

function licenciaRoleAssignment(payload, sedeId) {
  const tipo = String(payload?.tipo_licencia || 'club_afiliado').trim().toLowerCase();
  if (tipo === 'master_ciudad') {
    return {
      role: 'admin_nacional',
      alcance: 'ciudad',
      sede_id: null,
      ...buildAdminRoleGeography('ciudad', {
        ciudad: payload?.ciudad_representa || payload?.ciudad,
        provincia: payload?.provincia_representa || payload?.provincia,
        pais: payload?.pais_representa || payload?.pais,
      }),
    };
  }
  if (tipo === 'master_provincia') {
    return {
      role: 'admin_nacional',
      alcance: 'provincia',
      sede_id: null,
      ...buildAdminRoleGeography('provincia', {
        provincia: payload?.provincia_representa || payload?.provincia,
        pais: payload?.pais_representa || payload?.pais,
      }),
    };
  }
  if (tipo === 'master_pais') {
    return {
      role: 'admin_nacional',
      alcance: 'pais',
      sede_id: null,
      ciudad: null,
      provincia: null,
      pais: String(payload?.pais_representa || payload?.licenciatario_pais || payload?.pais || '').trim() || null,
    };
  }
  return {
    role: 'admin_club',
    alcance: 'sede',
    sede_id: sedeId,
    ciudad: null,
    provincia: null,
    pais: String(payload?.licenciatario_pais || payload?.pais || '').trim() || null,
  };
}

async function upsertUserRoleLicenciaAsignada({ email, nombre, payload, sedeId }) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return new Error('Email licenciatario vacío');
  let a;
  try {
    a = licenciaRoleAssignment(payload, sedeId);
    if (a.role === 'admin_nacional') buildAdminRoleGeography(a.alcance, a);
  } catch (error) {
    return error;
  }
  if (a.alcance === 'ciudad' && !a.ciudad) return new Error('Falta ciudad_representa para alcance ciudad');
  if (a.alcance === 'provincia' && !a.provincia) return new Error('Falta provincia_representa para alcance provincia');
  if (a.alcance === 'pais' && !a.pais) return new Error('Falta pais_representa para alcance pais');

  const row = {
    email: em,
    role: a.role,
    alcance: a.alcance,
    nombre: String(nombre || '').trim() || null,
    sede_id: a.sede_id ?? null,
    ciudad: a.ciudad ?? null,
    provincia: a.provincia ?? null,
    pais: a.pais ?? null,
    torneos_oficiales_habilitados: a.role === 'admin_nacional',
  };
  const { data: ex } = await supabase.from('user_roles').select('email').eq('email', em).maybeSingle();
  if (ex?.email) {
    const { error } = await supabase.from('user_roles').update(row).eq('email', em);
    return error || null;
  }
  const { error } = await supabase.from('user_roles').insert(row);
  return error || null;
}

async function ensureLicenciatarioAuthUserAndWelcomeEmail(email, opts = {}) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return { created: false, tempPassword: null };
  const tempPassword = randomTemporaryPassword();
  let created = false;
  const cr = await supabase.auth.admin.createUser({
    email: em,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { temp_password: true },
  });
  if (cr.error) {
    // Auth documents these codes as existing accounts. HTTP 422 alone also
    // covers validation/password policy failures; it does not prove an account exists.
    if (!['email_exists', 'user_already_exists'].includes(cr.error.code)) throw cr.error;
  } else {
    if (!cr.data?.user?.id || String(cr.data.user.email || '').trim().toLowerCase() !== em) {
      throw new Error('AUTH_PROVISION_RECEIPT_INVALID');
    }
    created = true;
  }
  if (created) {
    void sendMakeEvent('jugador_registrado', {
      email: em,
      nombre: String(opts?.nombre || '').trim() || null,
      pais: String(opts?.pais || '').trim() || null,
      ciudad: String(opts?.ciudad || '').trim() || null,
    });
  }
  // Existing accounts keep their current credentials. Do not trigger a
  // password-recovery email just because another seat invited their owner.
  if (!created) {
    return { created: false, tempPassword: null, access_state: 'sign_in_or_recovery',
      welcome_delivery: 'not_requested_existing_account' };
  }
  if (runtime.outboundDeliveryEnabled) {
    const delivery = await supabase.auth.resetPasswordForEmail(em, {
      redirectTo: `${FRONTEND_URL}/login`,
    });
    if (delivery?.error) throw delivery.error;
    if (!delivery || !delivery.data) throw new Error('AUTH_RECOVERY_RECEIPT_INVALID');
  }
  return { created, tempPassword, access_state: runtime.outboundDeliveryEnabled
    ? 'recovery_email_requested' : 'new_account_delivery_disabled',
    welcome_delivery: runtime.outboundDeliveryEnabled ? 'requested_not_verified' : 'disabled' };
}

// Shared guards for the callers that provision a licenciatario Auth user.
// They are deterministic (no side effects) and run before any seat, link, role
// or invitation write and before the Auth call. Failure responses stay stable
// and never expose provider detail, temporary passwords or tokens.
function normalizarEmailLicenciatario(raw) {
  return String(raw || '').trim().toLowerCase();
}

function emailLicenciatarioPlausible(email) {
  return /^[^\s@]+@[^\s@]+$/.test(normalizarEmailLicenciatario(email));
}

function rechazarAccesoNoDisponible(res) {
  return res.status(503).json({
    error: 'No se pudo preparar el acceso. Reintentá en unos minutos.',
    code: 'SEDE_ACCESS_PROVISION_UNAVAILABLE',
    retry: true,
  });
}

// The club seat creation is a single PostgreSQL transaction exposed as an RPC.
// If the routine is not deployed, fail closed: never fall back to the previous
// multi-step REST flow that could create duplicate seats/roles on retry.
function rechazarAltaAtomicaNoDisponible(res) {
  return res.status(503).json({
    error: 'El alta atómica de la sede no está disponible en este entorno.',
    code: 'INVITACION_ATOMIC_RPC_UNAVAILABLE',
    retry: false,
  });
}

function rpcAltaAtomicaNoDisponible(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  if (code === 'PGRST202' || code === 'PGRST203' || code === '42883') return true;
  if (/could not find the function/i.test(msg)) return true;
  return /completar_invitacion_club_atomica/i.test(msg) && /does not exist/i.test(msg);
}

function validarAsignacionRolLicencia(payload) {
  const asignacion = licenciaRoleAssignment(payload, null);
  if (asignacion.role === 'admin_nacional') buildAdminRoleGeography(asignacion.alcance, asignacion);
  const faltante = asignacion.alcance === 'ciudad' && !asignacion.ciudad
    ? 'Falta ciudad_representa para alcance ciudad'
    : asignacion.alcance === 'provincia' && !asignacion.provincia
      ? 'Falta provincia_representa para alcance provincia'
      : asignacion.alcance === 'pais' && !asignacion.pais
        ? 'Falta pais_representa para alcance pais'
        : null;
  if (faltante) {
    const error = new Error(faltante);
    error.status = 400;
    throw error;
  }
  return asignacion;
}

function validarInvitacionGeoTerritorio(inv) {
  const alcance = String(inv?.invited_alcance || '').trim().toLowerCase();
  if (!['pais', 'provincia', 'ciudad'].includes(alcance)) {
    const error = new Error('Tipo de invitación geográfica no válido');
    error.status = 400;
    throw error;
  }
  const campo = alcance === 'pais' ? 'pais' : alcance === 'provincia' ? 'provincia' : 'ciudad';
  if (!String(inv?.[campo] || '').trim()) {
    const label = { pais: 'País', provincia: 'Provincia', ciudad: 'Ciudad' }[campo];
    const error = new Error(`${label} obligatorio en la invitación`);
    error.status = 400;
    throw error;
  }
  buildAdminRoleGeography(alcance, inv);
}

app.post('/api/admin/roles', async (req, res) => {
  try {
    const actorScope = await assertSuperAdminReq(req);
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const role = String(b.role || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email obligatorio' });

    if (role === 'editor_contenido') {
      const nombre = String(b.nombre || '').trim() || null;
      const payload = {
        email,
        role: 'editor_contenido',
        alcance: 'global',
        sede_id: null,
        ciudad: null,
        provincia: null,
        pais: null,
        nombre,
        torneos_oficiales_habilitados: false,
      };
      const { data: existing } = await supabase.from('user_roles').select('email').eq('email', email).maybeSingle();
      let r;
      if (existing?.email) {
        r = await supabase.from('user_roles').update(payload).eq('email', email).select('*').single();
      } else {
        r = await supabase.from('user_roles').insert(payload).select('*').single();
      }
      if (r.error) throw r.error;

      let magic_link = null;
      try {
        const ml = await generateAdminInviteMagicLink({
          email,
          rol: 'editor_contenido',
          nombre,
          assignRole: true,
        });
        magic_link = ml.magic_link;
      } catch (mlErr) {
        console.warn('⚠️ magic link editor_contenido:', mlErr?.message || mlErr);
      }
      void notifyMakeAdminInviteWebhook({
        email,
        nombre,
        rol: 'editor_contenido',
        sede_id: null,
      });
      return res.json({ ...r.data, magic_link });
    }

    const alcance = String(b.alcance || '').trim().toLowerCase();
    if (!['admin_club', 'admin_cadena', 'admin_nacional', 'empleado'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    if (!['sede', 'organizacion', 'ciudad', 'provincia', 'pais'].includes(alcance)) {
      return res.status(400).json({ error: 'Alcance inválido' });
    }
    if (role === 'admin_cadena' && alcance !== 'organizacion') {
      return res.status(400).json({ error: 'El administrador de cadena debe tener alcance organización' });
    }
    if (role !== 'admin_cadena' && alcance === 'organizacion') {
      return res.status(400).json({ error: 'El alcance organización corresponde al administrador de cadena' });
    }
    if (role === 'empleado' && alcance !== 'sede') {
      return res.status(400).json({ error: 'El rol empleado debe tener alcance sede' });
    }
    const sedeId = b.sede_id != null && String(b.sede_id).trim() !== '' ? Number(b.sede_id) : null;
    const organizacionId = b.organizacion_id ? String(b.organizacion_id).trim().toLowerCase() : null;
    if (alcance === 'sede' && !Number.isFinite(sedeId)) {
      return res.status(400).json({ error: 'sede_id es obligatorio para alcance sede' });
    }
    const geography = buildAdminRoleGeography(alcance, b);
    if (alcance === 'organizacion') {
      if (!organizacionId) return res.status(400).json({ error: 'organizacion_id obligatorio' });
      const { data: org, error: orgError } = await supabase.from('organizaciones').select('id').eq('id', organizacionId).maybeSingle();
      if (orgError) throw orgError;
      if (!org) return res.status(404).json({ error: 'Organización no encontrada' });
    }

    const payload = {
      email,
      role,
      alcance,
      nombre: String(b.nombre || '').trim() || null,
      sede_id: alcance === 'sede' ? sedeId : null,
      organizacion_id: alcance === 'organizacion' ? organizacionId : null,
      ...geography,
      torneos_oficiales_habilitados: role === 'admin_nacional',
    };
    if (typeof supabase.rpc !== 'function') return res.status(503).json({
      error: 'La asignación atómica no está disponible.', code: 'ADMIN_ROLE_ATOMIC_UNAVAILABLE',
    });
    const { data: result, error: roleError } = await supabase.rpc('asignar_rol_admin_atomico', {
      p_actor_id: actorScope?.authUserId, p_payload: payload,
    });
    if (roleError) {
      const missing = ['PGRST202', 'PGRST203', '42883'].includes(String(roleError.code || ''));
      const status = missing ? 503 : roleError.code === '42501' ? 403 : roleError.code === '22023' ? 400 : 500;
      return res.status(status).json({ error: 'No se pudo asignar el rol. Revisá la operación antes de reintentar.',
        code: missing ? 'ADMIN_ROLE_ATOMIC_UNAVAILABLE' : 'ADMIN_ROLE_ATOMIC_FAILED' });
    }
    if (result?.ok === false && result.reason === 'ambiguous_email') return res.status(409).json({
      error: 'El email tiene más de una asignación. Revisá los roles existentes antes de continuar.', code: 'ADMIN_ROLE_EMAIL_AMBIGUOUS',
    });
    if (result?.ok !== true || !result.row?.id || result.row.email !== email || result.row.role !== role) return res.status(500).json({
      error: 'No se pudo confirmar la asignación.', code: 'ADMIN_ROLE_BAD_RECEIPT',
    });
    res.json(result.row);
  } catch (err) {
    console.error('❌ POST /api/admin/roles:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/admin/roles/:email', async (req, res) => {
  try {
    await assertSuperAdminReq(req);
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email inválido' });
    const { error } = await supabase.from('user_roles').delete().eq('email', email);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /api/admin/roles/:email:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

const INVITACION_ADMIN_HORAS_VALIDEZ = 48;

function generarTokenInvitacionAdmin() {
  return crypto.randomBytes(32).toString('hex');
}

async function sendInvitacionAdminClubEmail({ toEmail, inviteUrl, nombreClub, paisLabel }) {
  const apiKey = runtime.outboundDeliveryEnabled ? String(process.env.RESEND_API_KEY || '').trim() : '';
  const from = String(process.env.RESEND_FROM_EMAIL || 'Padbol Match <no-reply@padbolmatch.com>').trim();
  const to = String(toEmail || '').trim().toLowerCase();
  if (!apiKey || !to) {
    console.warn('⚠️ Invitación admin club: sin RESEND_API_KEY o email vacío — no se envía mail');
    return false;
  }
  const club = String(nombreClub || '').trim();
  const pais = String(paisLabel || '').trim();
  const bodyHtml = `
    <p>Hola,</p>
    <p>Te invitaron a ser <strong>administrador de club</strong> en Padbol Match.</p>
    ${club ? `<p><strong>Club sugerido:</strong> ${club}</p>` : ''}
    ${pais ? `<p><strong>País:</strong> ${pais}</p>` : ''}
    <p>Completa el alta de tu sede en el siguiente enlace (válido ${INVITACION_ADMIN_HORAS_VALIDEZ} horas):</p>
    <p><a href="${inviteUrl}" style="font-weight:700;color:#4f46e5;">Completar alta de sede</a></p>
    <p>Si el botón no funciona, copia y pega esta URL en el navegador:<br/><span style="word-break:break-all;font-size:13px;">${inviteUrl}</span></p>
    <p><strong>PADBOL Match</strong></p>
  `;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Invitación para administrar tu club en Padbol Match',
        html: bodyHtml,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('⚠️ Resend invitación admin:', r.status, t);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('⚠️ Email invitación admin club:', e?.message || e);
    return false;
  }
}

async function sendInvitacionAdminGeoEmail({ toEmail, inviteUrl, paisLabel, invitedAlcance, provincia, ciudad }) {
  const apiKey = runtime.outboundDeliveryEnabled ? String(process.env.RESEND_API_KEY || '').trim() : '';
  const from = String(process.env.RESEND_FROM_EMAIL || 'Padbol Match <no-reply@padbolmatch.com>').trim();
  const to = String(toEmail || '').trim().toLowerCase();
  if (!apiKey || !to) {
    console.warn('⚠️ Invitación admin geo: sin RESEND_API_KEY o email vacío — no se envía mail');
    return false;
  }
  const alc = String(invitedAlcance || '').trim().toLowerCase();
  const pais = String(paisLabel || '').trim();
  const prov = String(provincia || '').trim();
  const ciu = String(ciudad || '').trim();
  let rolTxt = 'administrador nacional';
  let scopeHtml = '';
  if (alc === 'pais') {
    rolTxt = 'administrador nacional';
    scopeHtml = pais ? `<p><strong>País:</strong> ${pais}</p>` : '';
  } else if (alc === 'provincia') {
    rolTxt = 'administrador de ciudad / región';
    scopeHtml = `<p><strong>País:</strong> ${pais || '—'}</p><p><strong>Provincia o estado:</strong> ${prov || '—'}</p>`;
  } else if (alc === 'ciudad') {
    rolTxt = 'administrador de ciudad / región';
    scopeHtml = `<p><strong>País:</strong> ${pais || '—'}</p>${prov ? `<p><strong>Provincia o estado:</strong> ${prov}</p>` : ''}${
      ciu ? `<p><strong>Ciudad:</strong> ${ciu}</p>` : ''
    }`;
  }
  const bodyHtml = `
    <p>Hola,</p>
    <p>Te invitaron a ser <strong>${rolTxt}</strong> en Padbol Match.</p>
    ${scopeHtml}
    <p>Acepta la invitación en el siguiente enlace (válido ${INVITACION_ADMIN_HORAS_VALIDEZ} horas). No crea una sede: solo activa tu acceso con el alcance indicado.</p>
    <p><a href="${inviteUrl}" style="font-weight:700;color:#4f46e5;">Aceptar invitación</a></p>
    <p>Si el botón no funciona, copia y pega esta URL en el navegador:<br/><span style="word-break:break-all;font-size:13px;">${inviteUrl}</span></p>
    <p><strong>PADBOL Match</strong></p>
  `;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Invitación como administrador en Padbol Match',
        html: bodyHtml,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('⚠️ Resend invitación admin geo:', r.status, t);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('⚠️ Email invitación admin geo:', e?.message || e);
    return false;
  }
}

function invitacionAdminUrl(token) {
  const base = String(FRONTEND_URL || '').replace(/\/$/, '');
  return `${base}/invitar-admin-club/${encodeURIComponent(token)}`;
}

function buildDeportesSedeRows(sedeId, deportesArr) {
  const arr = Array.isArray(deportesArr) ? deportesArr : null;
  if (!arr || arr.length === 0) {
    const e = new Error('deportes debe ser un array no vacío');
    e.status = 400;
    throw e;
  }
  const rows = [];
  for (const raw of arr) {
    const dep = String(raw?.deporte || '').trim().toLowerCase();
    const n = parseInt(String(raw?.cantidad ?? ''), 10);
    if (!DEPORTES_SEDE_VALID.has(dep)) {
      const e = new Error(`Deporte no permitido: ${dep || '(vacío)'}`);
      e.status = 400;
      throw e;
    }
    if (!Number.isFinite(n) || n < 0) {
      const e = new Error(`Cantidad inválida para ${dep}`);
      e.status = 400;
      throw e;
    }
    if (n === 0) continue;
    rows.push({ sede_id: sedeId, deporte: dep, cantidad: n, activo: true });
  }
  if (!rows.length) {
    const e = new Error('Al menos un deporte con cantidad mayor a 0');
    e.status = 400;
    throw e;
  }
  return rows;
}

async function insertDeportesSedeSinAuth(sedeId, deportesArr) {
  const rows = buildDeportesSedeRows(sedeId, deportesArr);
  const { error: delErr } = await supabase.from('canchas_por_deporte').delete().eq('sede_id', sedeId);
  if (delErr) throw delErr;
  const { data: ins, error: insErr } = await supabase.from('canchas_por_deporte').insert(rows).select('*');
  if (insErr) throw insErr;
  return ins || [];
}

app.post('/api/admin/invite-magic-link', async (req, res) => {
  try {
    await assertSuperAdminReq(req);
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const rol = String(b.rol || b.role || '').trim().toLowerCase();
    const nombre = String(b.nombre || '').trim() || null;
    const sede_id =
      b.sede_id != null && String(b.sede_id).trim() !== '' ? Number(b.sede_id) : null;
    if (!email) return res.status(400).json({ error: 'Email obligatorio' });
    if (!rol || !MAGIC_INVITE_ROLES.has(rol)) {
      return res.status(400).json({
        error: 'Rol inválido (editor_contenido, admin_cadena, admin_club, admin_nacional, empleado)',
      });
    }
    const assignRole =
      b.assign_role === true ||
      b.assign_role === 'true' ||
      rol === 'editor_contenido' ||
      (rol === 'empleado' && sede_id != null);
    const out = await generateAdminInviteMagicLink({
      email,
      rol,
      nombre,
      sede_id,
      assignRole,
    });
    res.json(out);
  } catch (err) {
    console.error('❌ POST /api/admin/invite-magic-link:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/webhooks/invitacion-admin', async (req, res) => {
  try {
    assertInvitacionWebhookSecret(req);
    const parsed = parseInvitacionAdminWebhookBody(req.body);
    if (!parsed.email) return res.status(400).json({ success: false, error: 'Email obligatorio en payload' });
    const rol = parsed.rol || 'admin_club';
    if (!MAGIC_INVITE_ROLES.has(rol)) {
      return res.status(400).json({ success: false, error: `Rol inválido: ${rol}` });
    }
    const assignRole = rol === 'editor_contenido' || (rol === 'empleado' && parsed.sede_id != null);
    const out = await generateAdminInviteMagicLink({
      email: parsed.email,
      rol,
      nombre: parsed.nombre,
      sede_id: parsed.sede_id,
      assignRole,
    });
    res.json({ success: true, magic_link: out.magic_link, email: out.email, nombre: out.nombre, rol: out.rol });
  } catch (err) {
    console.error('❌ POST /api/webhooks/invitacion-admin:', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/invitaciones-admin', async (req, res) => {
  try {
    await assertSuperAdminReq(req);
    const est = String(req.query?.estado || '').trim().toLowerCase();
    let q = supabase
      .from('invitaciones_admin')
      .select(
        'id, email, pais, nombre_club, estado, created_at, expires_at, sede_id, invited_role, invited_alcance, provincia, ciudad',
      )
      .order('created_at', { ascending: false })
      .limit(300);
    if (est && ['pendiente', 'completada', 'expirada', 'cancelada'].includes(est)) {
      q = q.eq('estado', est);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('❌ GET /api/admin/invitaciones-admin:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/invitaciones-admin', async (req, res) => {
  try {
    await assertSuperAdminReq(req);
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const pais = String(b.pais || '').trim();
    if (!email) return res.status(400).json({ error: 'Email obligatorio' });
    if (!pais) return res.status(400).json({ error: 'País obligatorio' });
    const tipoInv = String(b.tipo_invitacion || b.tipo || 'club').trim().toLowerCase();

    let invitedRole = 'admin_club';
    let invitedAlcance = null;
    let nombreClub = String(b.nombre_club || '').trim() || null;
    let provinciaIns = null;
    let ciudadIns = null;

    if (tipoInv === 'nacional') {
      invitedRole = 'admin_nacional';
      invitedAlcance = 'pais';
      nombreClub = null;
    } else if (tipoInv === 'ciudad_region') {
      invitedRole = 'admin_nacional';
      const prov = String(b.provincia || b.estado || '').trim();
      const ciu = String(b.ciudad || '').trim();
      if (!prov) return res.status(400).json({ error: 'Provincia / estado obligatorio' });
      provinciaIns = prov;
      ciudadIns = ciu || null;
      invitedAlcance = ciu ? 'ciudad' : 'provincia';
      nombreClub = null;
    } else if (tipoInv !== 'club') {
      return res.status(400).json({ error: 'tipo_invitacion inválido (club, nacional, ciudad_region)' });
    }

    if (invitedAlcance) {
      buildAdminRoleGeography(invitedAlcance, { pais: b.pais, provincia: b.provincia || b.estado, ciudad: b.ciudad });
    }

    await supabase
      .from('invitaciones_admin')
      .update({ estado: 'cancelada' })
      .eq('email', email)
      .eq('estado', 'pendiente');

    const token = generarTokenInvitacionAdmin();
    const expiresAt = new Date(Date.now() + INVITACION_ADMIN_HORAS_VALIDEZ * 3600 * 1000).toISOString();
    const { data: row, error: insErr } = await supabase
      .from('invitaciones_admin')
      .insert({
        email,
        token,
        pais,
        nombre_club: nombreClub,
        estado: 'pendiente',
        expires_at: expiresAt,
        invited_role: invitedRole,
        invited_alcance: invitedAlcance,
        provincia: provinciaIns,
        ciudad: ciudadIns,
      })
      .select(
        'id, email, pais, nombre_club, estado, created_at, expires_at, sede_id, invited_role, invited_alcance, provincia, ciudad',
      )
      .single();
    if (insErr) throw insErr;

    const url = invitacionAdminUrl(token);
    const mailed = invitacionAdminEsFlujoGeo(row)
      ? await sendInvitacionAdminGeoEmail({
          toEmail: email,
          inviteUrl: url,
          paisLabel: pais,
          invitedAlcance: row.invited_alcance,
          provincia: row.provincia,
          ciudad: row.ciudad,
        })
      : await sendInvitacionAdminClubEmail({
          toEmail: email,
          inviteUrl: url,
          nombreClub,
          paisLabel: pais,
        });

    void sendMakeEvent('invitacion_admin_creada', {
      invitacion_id: row.id,
      email: row.email,
      invited_role: row.invited_role || invitedRole,
      invited_alcance: row.invited_alcance,
      pais: row.pais,
      nombre_club: row.nombre_club,
      provincia: row.provincia,
      ciudad: row.ciudad,
      invite_token_url: url,
    });

    let magic_link = null;
    try {
      const ml = await generateAdminInviteMagicLink({
        email: row.email,
        rol: row.invited_role || invitedRole,
        nombre: row.nombre_club || nombreClub,
        sede_id: row.sede_id,
        assignRole: false,
      });
      magic_link = ml.magic_link;
    } catch (mlErr) {
      console.warn('⚠️ magic link invitación admin:', mlErr?.message || mlErr);
    }

    void notifyMakeAdminInviteWebhook({
      email: row.email,
      nombre: row.nombre_club ?? nombreClub ?? null,
      rol: String(row.invited_role || invitedRole).trim().toLowerCase(),
      sede_id: row.sede_id ?? null,
    });

    res.status(201).json({ ...row, email_sent: mailed, invite_url: url, magic_link });
  } catch (err) {
    console.error('❌ POST /api/admin/invitaciones-admin:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/admin/invitaciones-admin/:id/reenviar', async (req, res) => {
  try {
    await assertSuperAdminReq(req);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { data: row, error: fErr } = await supabase.from('invitaciones_admin').select('*').eq('id', id).maybeSingle();
    if (fErr) throw fErr;
    if (!row?.id) return res.status(404).json({ error: 'Invitación no encontrada' });
    if (row.estado !== 'pendiente') {
      return res.status(400).json({ error: 'Solo se puede reenviar invitaciones pendientes' });
    }
    const now = Date.now();
    const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    let token = row.token;
    let expiresAt = row.expires_at;
    if (!Number.isFinite(expMs) || expMs <= now) {
      token = generarTokenInvitacionAdmin();
      expiresAt = new Date(Date.now() + INVITACION_ADMIN_HORAS_VALIDEZ * 3600 * 1000).toISOString();
      const { error: uErr } = await supabase
        .from('invitaciones_admin')
        .update({ token, expires_at: expiresAt })
        .eq('id', id)
        .eq('estado', 'pendiente');
      if (uErr) throw uErr;
    }
    const url = invitacionAdminUrl(token);
    const mailed = invitacionAdminEsFlujoGeo(row)
      ? await sendInvitacionAdminGeoEmail({
          toEmail: row.email,
          inviteUrl: url,
          paisLabel: row.pais,
          invitedAlcance: row.invited_alcance,
          provincia: row.provincia,
          ciudad: row.ciudad,
        })
      : await sendInvitacionAdminClubEmail({
          toEmail: row.email,
          inviteUrl: url,
          nombreClub: row.nombre_club,
          paisLabel: row.pais,
        });

    void notifyMakeAdminInviteWebhook({
      email: row.email,
      nombre: row.nombre_club ?? null,
      rol: String(row.invited_role || 'admin_club').trim().toLowerCase(),
      sede_id: row.sede_id ?? null,
    });

    res.json({ ok: true, email_sent: mailed, expires_at: expiresAt });
  } catch (err) {
    console.error('❌ POST /api/admin/invitaciones-admin/:id/reenviar:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/invitacion/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 16) return res.status(404).json({ error: 'Invitación no encontrada' });
    const { data: row, error } = await supabase.from('invitaciones_admin').select('*').eq('token', token).maybeSingle();
    if (error) throw error;
    if (!row?.id) return res.status(404).json({ error: 'Invitación no encontrada' });
    if (row.estado !== 'pendiente') {
      return res.status(410).json({ error: 'Esta invitación ya no está activa', estado: row.estado });
    }
    const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (Number.isFinite(expMs) && expMs <= Date.now()) {
      await supabase.from('invitaciones_admin').update({ estado: 'expirada' }).eq('id', row.id).eq('estado', 'pendiente');
      return res.status(410).json({ error: 'Invitación expirada' });
    }
    res.json({
      valid: true,
      flow: invitacionAdminEsFlujoGeo(row) ? 'geo' : 'club',
      email: row.email,
      pais: row.pais,
      nombre_club: row.nombre_club || '',
      expires_at: row.expires_at,
      invited_role: row.invited_role || 'admin_club',
      invited_alcance: row.invited_alcance || null,
      provincia: row.provincia || '',
      ciudad: row.ciudad || '',
    });
  } catch (err) {
    console.error('❌ GET /api/invitacion/:token:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.post('/api/invitacion/:token/completar', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length < 16) return res.status(404).json({ error: 'Invitación no encontrada' });
    const { data: inv, error: iErr } = await supabase.from('invitaciones_admin').select('*').eq('token', token).maybeSingle();
    if (iErr) throw iErr;
    if (!inv?.id) return res.status(404).json({ error: 'Invitación no encontrada' });
    if (inv.estado !== 'pendiente') {
      return res.status(410).json({ error: 'Esta invitación ya no está activa', estado: inv.estado });
    }
    const expMs = inv.expires_at ? new Date(inv.expires_at).getTime() : 0;
    if (Number.isFinite(expMs) && expMs <= Date.now()) {
      await supabase.from('invitaciones_admin').update({ estado: 'expirada' }).eq('id', inv.id).eq('estado', 'pendiente');
      return res.status(410).json({ error: 'Invitación expirada' });
    }

    const b = req.body || {};
    const emailInv = String(inv.email || '').trim().toLowerCase();
    const emailContacto = String(b.email_contacto || '').trim().toLowerCase();
    if (!emailContacto || emailContacto !== emailInv) {
      return res.status(400).json({ error: 'El email de contacto debe coincidir con el de la invitación' });
    }

    if (invitacionAdminEsFlujoGeo(inv)) {
      const nombreAdmin = String(b.nombre_admin || '').trim() || null;
      if (!emailLicenciatarioPlausible(emailInv)) {
        return res.status(400).json({ error: 'El email de la invitación no es válido' });
      }
      try {
        validarInvitacionGeoTerritorio(inv);
      } catch (validationError) {
        return res.status(400).json({ error: validationError.message || 'Invitación geográfica inválida' });
      }
      // Provision the Auth account before mutating the role or consuming the
      // invitation, so an Auth/provider failure leaves the invitation retryable.
      let accessProvision;
      try {
        accessProvision = await ensureLicenciatarioAuthUserAndWelcomeEmail(emailInv, {
          nombre: nombreAdmin,
          pais: String(inv.pais || '').trim() || null,
          ciudad: String(inv.ciudad || '').trim() || null,
        });
      } catch (authErr) {
        console.warn('⚠️ Alta rol geo por invitación: provisión auth no disponible:', authErr?.code || authErr?.status || 'provision_failed');
        return rechazarAccesoNoDisponible(res);
      }
      const urErr = await upsertUserRoleFromInvitacionGeo({
        email: emailInv,
        nombre: nombreAdmin,
        inv,
      });
      if (urErr) throw new Error(urErr.message || String(urErr));
      const { error: upInvGeoErr } = await supabase
        .from('invitaciones_admin')
        .update({ estado: 'completada', sede_id: null })
        .eq('id', inv.id)
        .eq('estado', 'pendiente');
      if (upInvGeoErr) {
        console.error('⚠️ Invitación geo no actualizada:', upInvGeoErr.code || upInvGeoErr.status || 'db_error');
        return res.status(500).json({
          error: 'El acceso quedó preparado pero la invitación no se pudo completar. Reintentá o revisá la invitación.',
          code: 'INVITACION_UPDATE_FAILED',
          role_assigned: true,
          access_state: accessProvision.access_state,
          welcome_delivery: accessProvision.welcome_delivery,
        });
      }
      return res.status(201).json({
        ok: true,
        flow: 'geo',
        access_state: accessProvision.access_state,
        welcome_delivery: accessProvision.welcome_delivery,
      });
    }

    const nombre = String(b.nombre || '').trim();
    const ciudad = String(b.ciudad || '').trim();
    const pais = String(b.pais || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Nombre de la sede obligatorio' });
    if (!ciudad) return res.status(400).json({ error: 'Ciudad obligatoria' });
    if (!pais) return res.status(400).json({ error: 'País obligatorio' });

    const latitudBody = b.latitud != null && String(b.latitud).trim() !== '' ? Number(b.latitud) : null;
    const longitudBody = b.longitud != null && String(b.longitud).trim() !== '' ? Number(b.longitud) : null;
    const mapsParsed = parseLatLngFromMapsUrl(b.google_maps_url || b.maps_url || b.googleMapsUrl || '');
    const latitud = Number.isFinite(latitudBody) ? latitudBody : mapsParsed.latitud;
    const longitud = Number.isFinite(longitudBody) ? longitudBody : mapsParsed.longitud;
    const precioTurno = b.precio_turno != null && b.precio_turno !== '' ? Number(b.precio_turno) : null;
    const cantidadCanchasTotal =
      b.cantidad_canchas != null && String(b.cantidad_canchas).trim() !== ''
        ? parseInt(String(b.cantidad_canchas), 10)
        : null;
    const skipAutogenCanchas = Boolean(b.skip_autogen_canchas);
    const telefonoBody = String(b.telefono || b.whatsapp || '').trim();
    if (!telefonoBody) return res.status(400).json({ error: 'Teléfono / WhatsApp obligatorio' });

    const timezoneInv = normalizeSedeTimezone(
      b.timezone != null && String(b.timezone).trim()
        ? String(b.timezone).trim()
        : inferTimezoneFromCiudadPais(ciudad, pais),
    );

    const payload = {
      nombre,
      pais,
      provincia: String(b.provincia || b.estado || '').trim() || null,
      ciudad,
      timezone: timezoneInv,
      direccion: String(b.direccion || '').trim() || null,
      email_contacto: emailContacto,
      telefono: telefonoBody,
      horario_apertura: String(b.horario_apertura || '').trim() || null,
      horario_cierre: String(b.horario_cierre || '').trim() || null,
      precio_turno: Number.isFinite(precioTurno) ? precioTurno : null,
      moneda: String(b.moneda || 'ARS').trim().toUpperCase() || 'ARS',
      metodo_pago: normalizeMetodoPago(b.metodo_pago || 'mercadopago'),
      stripe_account_id: String(b.stripe_account_id || '').trim() || null,
      mp_access_token: String(b.mp_access_token || '').trim() || null,
      mp_public_key: String(b.mp_public_key || '').trim() || null,
      pago_manual_instrucciones: String(b.pago_manual_instrucciones || '').trim() || null,
      latitud: Number.isFinite(latitud) ? latitud : null,
      longitud: Number.isFinite(longitud) ? longitud : null,
      google_maps_url: String(b.google_maps_url || b.maps_url || '').trim() || null,
    };
    if (Number.isFinite(cantidadCanchasTotal) && cantidadCanchasTotal >= 0) {
      payload.cantidad_canchas = cantidadCanchasTotal;
    }

    const sedeInsert = buildSedeReleaseInsert(payload);
    const deportesRows = buildDeportesSedeRows(null, b.deportes);
    const nombreAdmin = String(b.nombre_admin || '').trim() || null;
    // Do not consume the invitation or change its seat/role while account
    // provisioning is unavailable. The same invitation can be retried later.
    let accessProvision;
    try {
      accessProvision = await ensureLicenciatarioAuthUserAndWelcomeEmail(emailInv, {
        nombre: nombreAdmin,
        pais,
        ciudad,
      });
    } catch {
      return res.status(503).json({
        error: 'No se pudo preparar el acceso. Reintentá en unos minutos con esta misma invitación.',
        code: 'SEDE_ACCESS_PROVISION_UNAVAILABLE',
        retry: true,
      });
    }

    // One durable transaction (claim invitation row, seat, courts, role and
    // token consumption). Any DB failure rolls all of those writes back.
    // Auth account creation and welcome email stay outside PostgreSQL with the
    // already accepted semantics; they are not part of this transaction.
    if (typeof supabase.rpc !== 'function') {
      return rechazarAltaAtomicaNoDisponible(res);
    }
    const { data: rpcOut, error: rpcErr } = await supabase.rpc('completar_invitacion_club_atomica', {
      p_token: token,
      p_email: emailInv,
      p_nombre_admin: nombreAdmin,
      p_sede: sedeInsert,
      p_deportes: deportesRows.map((row) => ({ deporte: row.deporte, cantidad: row.cantidad })),
    });
    if (rpcErr) {
      if (rpcAltaAtomicaNoDisponible(rpcErr)) return rechazarAltaAtomicaNoDisponible(res);
      console.error('⚠️ Alta atómica de sede por invitación falló:', rpcErr.code || rpcErr.message || 'db_error');
      return res.status(500).json({
        error: 'No se pudo completar el alta de la sede. La invitación queda disponible para reintentar.',
        code: 'INVITACION_ATOMIC_FAILED',
        retry: true,
      });
    }
    const outcome = rpcOut && typeof rpcOut === 'object' ? rpcOut : null;
    if (!outcome) {
      console.error('⚠️ Alta atómica de sede sin recibo válido');
      return res.status(500).json({
        error: 'No se pudo confirmar el alta de la sede.',
        code: 'INVITACION_ATOMIC_BAD_RECEIPT',
      });
    }
    if (outcome.ok !== true) {
      const reason = String(outcome.reason || '');
      if (reason === 'not_found') return res.status(404).json({ error: 'Invitación no encontrada' });
      if (reason === 'consumed') {
        return res.status(410).json({ error: 'Esta invitación ya no está activa', estado: outcome.estado || 'completada' });
      }
      if (reason === 'expired') return res.status(410).json({ error: 'Invitación expirada' });
      if (reason === 'email_mismatch') {
        return res.status(400).json({ error: 'El email de contacto debe coincidir con el de la invitación' });
      }
      if (reason === 'role_not_allowed' || reason === 'flow_mismatch') {
        return res.status(409).json({
          error: 'La invitación no corresponde a un alta de club',
          code: 'INVITACION_FLOW_MISMATCH',
        });
      }
      if (reason === 'invalid_payload') {
        return res.status(400).json({
          error: 'Datos de sede inválidos',
          code: 'SEDE_REQUIRED_CONFIGURATION',
          ...(outcome.detail ? { detail: String(outcome.detail) } : {}),
        });
      }
      console.error('⚠️ Alta atómica de sede rechazada:', reason || 'unknown');
      return res.status(500).json({
        error: 'No se pudo completar el alta de la sede.',
        code: 'INVITACION_ATOMIC_FAILED',
      });
    }
    const created = outcome.sede;
    const sedeId = Number(outcome.sede_id);
    if (!created || typeof created !== 'object' || !Number.isFinite(sedeId) || Number(created.id) !== sedeId) {
      console.error('⚠️ Alta atómica de sede con recibo inconsistente');
      return res.status(500).json({
        error: 'No se pudo confirmar el alta de la sede.',
        code: 'INVITACION_ATOMIC_BAD_RECEIPT',
      });
    }

    void sendMakeEvent('sede_creada', {
      nombre_sede: String(created?.nombre || nombre || '').trim() || null,
      pais: String(created?.pais || pais || '').trim() || null,
      ciudad: String(created?.ciudad || ciudad || '').trim() || null,
      email_contacto: emailContacto,
      deportes: Array.isArray(b.deportes) ? b.deportes : null,
      origen: 'invitacion_admin_club',
    });

    res.status(201).json({ ok: true, sede: pickPublicSedeWithPaymentStatus(created), sede_id: sedeId,
      access_state: accessProvision.access_state, welcome_delivery: accessProvision.welcome_delivery });
  } catch (err) {
    const st = err.status || 500;
    if (st >= 400 && st < 500) return res.status(st).json({ error: err.message || String(err) });
    console.error('❌ POST /api/invitacion/:token/completar:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

function mapPendingRowToSedeInsert(row) {
  const ciudadP = row.ciudad || null;
  const paisP = row.pais || null;
  const tz = normalizeSedeTimezone(
    row.timezone != null && String(row.timezone).trim()
      ? String(row.timezone).trim()
      : inferTimezoneFromCiudadPais(ciudadP, paisP),
  );
  return {
    nombre: String(row.nombre || '').trim(),
    direccion: row.direccion || null,
    ciudad: ciudadP,
    provincia: row.provincia || null,
    pais: paisP,
    timezone: tz,
    latitud: row.latitud != null ? Number(row.latitud) : null,
    longitud: row.longitud != null ? Number(row.longitud) : null,
    horario_apertura: row.horario_apertura || null,
    horario_cierre: row.horario_cierre || null,
    precio_turno: row.precio_base != null && row.precio_base !== '' ? Number(row.precio_base) : null,
    moneda: row.moneda || 'ARS',
    metodo_pago: normalizeMetodoPago(row.metodo_pago || 'mercadopago'),
    stripe_account_id: row.stripe_account_id || null,
    mp_access_token: row.mp_access_token || null,
    mp_public_key: row.mp_public_key || null,
    pago_manual_instrucciones: row.pago_manual_instrucciones || null,
    telefono: row.whatsapp || null,
    email_contacto: row.email_contacto || null,
    cantidad_canchas: row.cantidad_canchas_solicitadas == null ? null : Number(row.cantidad_canchas_solicitadas),
    numero_licencia: row.numero_licencia || null,
    fecha_licencia: row.fecha_contrato || null,
    licencia_activa: true,
    franjas_horarias: [],
    fotos_destacadas: [],
  };
}

app.post('/api/admin/sedes-pendientes', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.email) return res.status(401).json({ error: 'No autorizado' });
    const rowRole = await fetchUserRoleRow(user);
    const role = rowRole?.role || null;
    if (isSuperAdminApi(user.email, role)) {
      return res.status(403).json({ error: 'Usa “Crear sede” desde el formulario de super admin' });
    }
    if (!['admin_nacional', 'admin_cadena'].includes(role)) {
      return res.status(403).json({ error: 'Solo un administrador nacional o de cadena puede enviar solicitudes pendientes' });
    }
    const organizacionId = role === 'admin_cadena' ? rowRole?.organizacion_id || null : null;
    if (role === 'admin_cadena' && !organizacionId) {
      return res.status(403).json({ error: 'Tu usuario no tiene una organización multisede asignada' });
    }
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Nombre del club obligatorio' });
    const cantidadCanchas = Number.parseInt(String(b.cantidad_canchas ?? ''), 10);
    if (!Number.isFinite(cantidadCanchas) || cantidadCanchas <= 0) {
      return res.status(400).json({ error: 'Indica cuántas canchas tendrá la sede' });
    }
    const licEmail = String(b.licenciatario_email || '').trim().toLowerCase();
    if (!licEmail) return res.status(400).json({ error: 'Email del licenciatario obligatorio' });

    if (organizacionId) {
      const [orgResult, linksResult, pendingResult] = await Promise.all([
        supabase.from('organizaciones').select('estado, limite_sedes, limite_canchas_total').eq('id', organizacionId).maybeSingle(),
        supabase.from('organizacion_sedes').select('sede_id').eq('organizacion_id', organizacionId),
        supabase.from('sedes_pendientes').select('cantidad_canchas_solicitadas').eq('organizacion_id', organizacionId).eq('estado', 'pendiente'),
      ]);
      if (orgResult.error) throw orgResult.error;
      if (linksResult.error) throw linksResult.error;
      if (pendingResult.error) throw pendingResult.error;
      if (!orgResult.data || orgResult.data.estado !== 'activa') {
        return res.status(403).json({ error: 'La organización multisede no está activa' });
      }
      const linkedIds = (linksResult.data || []).map((link) => Number(link.sede_id)).filter(Number.isFinite);
      const pendingRows = pendingResult.data || [];
      if (linkedIds.length + pendingRows.length >= Number(orgResult.data.limite_sedes)) {
        return res.status(409).json({ error: `La cadena alcanzó su límite de ${orgResult.data.limite_sedes} sedes, incluyendo solicitudes pendientes` });
      }
      let linkedCourts = 0;
      if (linkedIds.length) {
        const { data: linkedSedes, error: linkedError } = await supabase.from('sedes').select('cantidad_canchas').in('id', linkedIds);
        if (linkedError) throw linkedError;
        linkedCourts = (linkedSedes || []).reduce((sum, sede) => sum + (Number(sede.cantidad_canchas) || 0), 0);
      }
      const pendingCourts = pendingRows.reduce((sum, pending) => sum + (Number(pending.cantidad_canchas_solicitadas) || 0), 0);
      if (linkedCourts + pendingCourts + cantidadCanchas > Number(orgResult.data.limite_canchas_total)) {
        return res.status(409).json({ error: `La solicitud supera el límite total de ${orgResult.data.limite_canchas_total} canchas de la cadena` });
      }
    }

    const insert = {
      created_by: String(user.email).trim().toLowerCase(),
      estado: 'pendiente',
      organizacion_id: organizacionId,
      cantidad_canchas_solicitadas: cantidadCanchas,
      nombre,
      direccion: b.direccion || null,
      ciudad: b.ciudad || null,
      provincia: b.provincia || null,
      pais: b.pais || null,
      latitud: b.latitud != null && b.latitud !== '' ? Number(b.latitud) : null,
      longitud: b.longitud != null && b.longitud !== '' ? Number(b.longitud) : null,
      horario_apertura: b.horario_apertura || null,
      horario_cierre: b.horario_cierre || null,
      precio_base: b.precio_base != null && b.precio_base !== '' ? Number(b.precio_base) : null,
      moneda: b.moneda || 'ARS',
      whatsapp: b.whatsapp || null,
      email_contacto: b.email_contacto || null,
      metodo_pago: normalizeMetodoPago(b.metodo_pago || 'mercadopago'),
      stripe_account_id: String(b.stripe_account_id || '').trim() || null,
      mp_access_token: String(b.mp_access_token || '').trim() || null,
      mp_public_key: String(b.mp_public_key || '').trim() || null,
      pago_manual_instrucciones: String(b.pago_manual_instrucciones || '').trim() || null,
      numero_licencia: b.numero_licencia || null,
      fecha_contrato: b.fecha_inicio_contrato || b.fecha_contrato || null,
      tipo_licencia: ['club_afiliado', 'padbol_point', 'master_ciudad', 'master_provincia', 'master_pais'].includes(String(b.tipo_licencia || '').trim())
        ? String(b.tipo_licencia).trim()
        : 'club_afiliado',
      ciudad_representa: b.ciudad_representa || null,
      provincia_representa: b.provincia_representa || null,
      pais_representa: b.pais_representa || null,
      licenciatario_nombre: b.licenciatario_nombre || null,
      licenciatario_email: licEmail,
      licenciatario_telefono: b.licenciatario_telefono || null,
      licenciatario_pais: b.licenciatario_pais || null,
    };

    let { data: ins, error } = await supabase.from('sedes_pendientes').insert(insert).select('id').single();
    if (
      error &&
      !organizacionId &&
      /ciudad_representa|provincia_representa|pais_representa|organizacion_id/i.test(String(error.message || ''))
    ) {
      const legacyInsert = { ...insert };
      delete legacyInsert.ciudad_representa;
      delete legacyInsert.provincia_representa;
      delete legacyInsert.pais_representa;
      delete legacyInsert.organizacion_id;
      delete legacyInsert.cantidad_canchas_solicitadas;
      const retry = await supabase.from('sedes_pendientes').insert(legacyInsert).select('id').single();
      ins = retry.data;
      error = retry.error;
    }
    if (error) throw error;

    const toSuper = resolveSuperAdminNotifyWhatsAppTo();
    if (toSuper) {
      const msg =
        `🏟 Nueva sede pendiente de aprobación\n` +
        `Club: ${nombre}\n` +
        `País: ${insert.pais || '—'}\n` +
        `Licenciatario: ${insert.licenciatario_nombre || '—'} (${licEmail})\n` +
        `Enviado por: ${insert.created_by}${organizacionId ? ' (cadena multisede)' : ''}\n` +
        `Revisar en: padbolmatch.com/admin`;
      await sendTwilioWhatsAppBodyToRaw(toSuper, msg);
    }

    res.json({ ok: true, id: ins?.id });
  } catch (err) {
    console.error('❌ POST /api/admin/sedes-pendientes:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

function buildDirectSedePayload(b, nombre) {
  return {
      nombre,
      direccion: b.direccion || null,
      ciudad: b.ciudad || null,
      provincia: b.provincia || null,
      pais: b.pais || null,
      timezone: normalizeSedeTimezone(
        b.timezone != null && String(b.timezone).trim()
          ? String(b.timezone).trim()
          : inferTimezoneFromCiudadPais(b.ciudad, b.pais),
      ),
      latitud: b.latitud != null && b.latitud !== '' ? Number(b.latitud) : null,
      longitud: b.longitud != null && b.longitud !== '' ? Number(b.longitud) : null,
      horario_apertura: b.horario_apertura || null,
      horario_cierre: b.horario_cierre || null,
      precio_turno: (b.precio_turno ?? b.precio_base) != null && String(b.precio_turno ?? b.precio_base).trim() !== '' ? Number(b.precio_turno ?? b.precio_base) : null,
      moneda: b.moneda || 'ARS',
      metodo_pago: normalizeMetodoPago(b.metodo_pago || 'mercadopago'),
      stripe_account_id: String(b.stripe_account_id || '').trim() || null,
      mp_access_token: String(b.mp_access_token || '').trim() || null,
      mp_public_key: String(b.mp_public_key || '').trim() || null,
      pago_manual_instrucciones: String(b.pago_manual_instrucciones || '').trim() || null,
      telefono: b.telefono || b.whatsapp || null,
      cantidad_canchas: b.cantidad_canchas ?? b.cantidad_canchas_solicitadas ?? null,
      email_contacto: b.email_contacto || null,
      numero_licencia: b.numero_licencia || null,
      fecha_licencia: b.fecha_inicio_contrato || b.fecha_contrato || null,
      licencia_activa: true,
      franjas_horarias: [],
      fotos_destacadas: [],
  };
}

function directFailure(res, error) {
  if (isDirectDbUnavailable(error)) {
    return res.status(503).json({ error: 'La operación durable no está disponible.', code: 'DIRECT_DB_UNAVAILABLE', retry: true });
  }
  const status = Number(error?.status || 0);
  if (status >= 400 && status < 600) {
    return res.status(status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  console.error('❌ Alta directa durable:', error?.code || error?.name || 'error');
  return res.status(500).json({ error: 'No se pudo completar el alta directa.', code: 'DIRECT_OPERATION_FAILED', retry: false });
}

async function handleKeyedDirectSede(req, res, operationKey) {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.id || !user?.email) return res.status(401).json({ error: 'No autorizado' });
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Nombre del club obligatorio' });
    const licEmail = normalizarEmailLicenciatario(b.licenciatario_email);
    if (!licEmail) return res.status(400).json({ error: 'Email del licenciatario obligatorio' });
    if (!emailLicenciatarioPlausible(licEmail)) return res.status(400).json({ error: 'Email del licenciatario inválido' });
    const sedePayload = buildDirectSedePayload(b, nombre);
    const sedeInsert = buildSedeReleaseInsert(sedePayload);
    const assignment = validarAsignacionRolLicencia(b);
    const organizacionId = b.organizacion_id ? String(b.organizacion_id).trim().toLowerCase() : null;
    const notify = b.licenciatario_telefono || b.whatsapp || null;
    const payloadDigest = directOperationDigest({ sede: sedeInsert, licEmail,
      licNombre: String(b.licenciatario_nombre || '').trim() || null, assignment, organizacionId, notify });

    let prepared;
    try {
      prepared = await prepareDirectOperation(pgPool, { actorId: user.id, actorEmail: user.email, operationKey, payloadDigest });
    } catch (error) { return directFailure(res, error); }
    if (prepared.state === 'completed') {
      return res.json({ ...prepared.operation.receipt, operation_key: operationKey, state: 'completed', replayed: true });
    }
    try {
      await preflightDirectRoleTarget(pgPool, { actorId: user.id, actorEmail: user.email, licEmail });
    } catch (error) { return directFailure(res, error); }

    let authProvision;
    try {
      authProvision = await ensureLicenciatarioAuthUserAndWelcomeEmail(licEmail, {
        nombre: String(b.licenciatario_nombre || '').trim() || null,
        pais: String(b.pais || '').trim() || null,
        ciudad: String(b.ciudad || '').trim() || null,
      });
    } catch (authErr) {
      console.warn('⚠️ Alta directa durable: provisión auth no disponible:', authErr?.code || authErr?.status || 'provision_failed');
      return rechazarAccesoNoDisponible(res);
    }

    let committed;
    try {
      committed = await commitDirectSeat(pgPool, {
        actorId: user.id, actorEmail: user.email, operationKey, payloadDigest, sedeInsert, licEmail,
        licNombre: String(b.licenciatario_nombre || '').trim() || null, assignment, organizacionId,
        authReceipt: { auth_user_created: Boolean(authProvision?.created),
          access_state: authProvision?.access_state ?? null, welcome_delivery: authProvision?.welcome_delivery ?? null },
      });
    } catch (error) { return directFailure(res, error); }
    if (committed.replayed) {
      return res.json({ ...committed.receipt, operation_key: operationKey, state: 'completed', replayed: true });
    }

    let welcomeDelivery = committed.receipt.welcome_delivery ?? null;
    const waLic = b.licenciatario_telefono || b.whatsapp;
    if (waLic) {
      const msg =
        `🎉 Bienvenido a PADBOL Match. Tu sede "${nombre}" está activa.\n` +
        `Ingresa al panel: padbolmatch.com/admin\n` +
        `${authProvision?.created
          ? (authProvision.access_state === 'recovery_email_requested'
              ? 'Tu cuenta está creada. Pedimos el email de recuperación; si no llega, recuperá el acceso desde el inicio de sesión.'
              : 'Tu cuenta está creada. Para configurar tu acceso, usá la recuperación desde el inicio de sesión.')
          : 'Ingresa con tu cuenta. Si no puedes entrar, recupera el acceso desde el inicio de sesión.'}`;
      try { await sendTwilioWhatsAppBodyToRaw(waLic, msg); }
      catch (notifyErr) {
        welcomeDelivery = 'not_verified_seat_completed';
        console.warn('⚠️ Alta directa durable: aviso post-commit no verificado:', notifyErr?.code || 'notify_failed');
      }
    }
    return res.json({ ...committed.receipt, welcome_delivery: welcomeDelivery,
      operation_key: operationKey, state: 'completed', replayed: false });
  } catch (error) {
    return directFailure(res, error);
  }
}

app.get('/api/admin/sedes-directa/operaciones/:operation_key', async (req, res) => {
  try {
    if (!pgPool) return res.status(503).json({ error: 'La operación durable no está disponible.', code: 'DIRECT_DB_UNAVAILABLE', retry: true });
    const operationKey = normalizeOperationKey(req.params.operation_key);
    if (!operationKey) return res.status(400).json({ error: 'operation_key inválido', code: 'DIRECT_OPERATION_KEY_INVALID' });
    const user = await authUserFromBearer(req);
    if (!user?.id) return res.status(401).json({ error: 'No autorizado' });
    const row = await readDirectOperation(pgPool, { actorId: user.id, operationKey });
    if (!row) return res.status(404).json({ error: 'Operación no encontrada', code: 'DIRECT_OPERATION_NOT_FOUND' });
    return res.json({ operation_key: operationKey, state: row.state, payload_digest: row.payload_digest, receipt: row.receipt || null });
  } catch (error) { return directFailure(res, error); }
});

app.post('/api/admin/sedes-directa/operaciones/:operation_key/cancelar', async (req, res) => {
  try {
    if (!pgPool) return res.status(503).json({ error: 'La operación durable no está disponible.', code: 'DIRECT_DB_UNAVAILABLE', retry: true });
    const operationKey = normalizeOperationKey(req.params.operation_key);
    if (!operationKey) return res.status(400).json({ error: 'operation_key inválido', code: 'DIRECT_OPERATION_KEY_INVALID' });
    const user = await authUserFromBearer(req);
    if (!user?.id) return res.status(401).json({ error: 'No autorizado' });
    const cancelled = await cancelDirectOperation(pgPool, { actorId: user.id, actorEmail: user.email, operationKey });
    if (!cancelled) return res.status(404).json({ error: 'Operación no encontrada', code: 'DIRECT_OPERATION_NOT_FOUND' });
    if (cancelled.state === 'completed') {
      return res.json({ ok: true, operation_key: operationKey, state: 'completed', replayed: true,
        sede_id: cancelled.operation.sede_id, receipt: cancelled.operation.receipt });
    }
    return res.json({ ok: true, operation_key: operationKey, state: 'cancelled', replayed: Boolean(cancelled.replayed) });
  } catch (error) { return directFailure(res, error); }
});

app.post('/api/admin/sedes-directa', async (req, res) => {
  try {
    const rawOperationKey = req.body?.operation_key;
    if (rawOperationKey !== undefined && rawOperationKey !== null && String(rawOperationKey).trim() !== '') {
      const operationKey = normalizeOperationKey(rawOperationKey);
      if (!operationKey) return res.status(400).json({ error: 'operation_key inválido', code: 'DIRECT_OPERATION_KEY_INVALID' });
      if (!pgPool) return res.status(503).json({ error: 'La operación durable no está disponible.', code: 'DIRECT_DB_UNAVAILABLE', retry: true });
      return await handleKeyedDirectSede(req, res, operationKey);
    }
    const user = await authUserFromBearer(req);
    if (!user?.id || !user?.email) return res.status(401).json({ error: 'No autorizado' });
    if (!await strictSuperAdminRole(supabase, user.id)) {
      return res.status(403).json({ error: 'Solo super admin puede crear sede directa' });
    }
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'Nombre del club obligatorio' });
    const licEmail = normalizarEmailLicenciatario(b.licenciatario_email);
    if (!licEmail) return res.status(400).json({ error: 'Email del licenciatario obligatorio' });
    if (!emailLicenciatarioPlausible(licEmail)) {
      return res.status(400).json({ error: 'Email del licenciatario inválido' });
    }

    const sedePayload = buildDirectSedePayload(b, nombre);
    // Deterministic checks that must never reach Auth: seat contract, email and
    // role geography are validated before provisioning or persisting anything.
    const sedeInsert = buildSedeReleaseInsert(sedePayload);
    validarAsignacionRolLicencia(b);

    // Provision Auth before writing seat/link/role: a failed Auth or reset leaves
    // zero writes and the operation stays retryable.
    let authProvision;
    try {
      authProvision = await ensureLicenciatarioAuthUserAndWelcomeEmail(licEmail, {
        nombre: String(b.licenciatario_nombre || '').trim() || null,
        pais: String(b.pais || '').trim() || null,
        ciudad: String(b.ciudad || '').trim() || null,
      });
    } catch (authErr) {
      console.warn('⚠️ Alta directa sede: provisión auth no disponible:', authErr?.code || authErr?.status || 'provision_failed');
      return rechazarAccesoNoDisponible(res);
    }

    const { data: sedeRow, error: sedeErr } = await supabase.from('sedes').insert(sedeInsert).select('id').single();
    if (sedeErr) throw sedeErr;
    const sedeId = sedeRow.id;

    const organizacionId = b.organizacion_id ? String(b.organizacion_id).trim().toLowerCase() : null;
    if (organizacionId) {
      const { error: orgLinkError } = await supabase
        .from('organizacion_sedes')
        .insert({ organizacion_id: organizacionId, sede_id: sedeId });
      if (orgLinkError) {
        await supabase.from('sedes').delete().eq('id', sedeId);
        throw orgLinkError;
      }
    }

    const urErr = await upsertUserRoleLicenciaAsignada({
      email: licEmail,
      nombre: String(b.licenciatario_nombre || '').trim() || null,
      payload: b,
      sedeId,
    });
    if (urErr) {
      await supabase.from('sedes').delete().eq('id', sedeId);
      throw urErr;
    }

    const waLic = b.licenciatario_telefono || b.whatsapp;
    if (waLic) {
      const msg =
        `🎉 Bienvenido a PADBOL Match. Tu sede "${nombre}" está activa.\n` +
        `Ingresa al panel: padbolmatch.com/admin\n` +
        `${authProvision?.created
          ? (authProvision.access_state === 'recovery_email_requested'
              ? 'Tu cuenta está creada. Pedimos el email de recuperación; si no llega, recuperá el acceso desde el inicio de sesión.'
              : 'Tu cuenta está creada. Para configurar tu acceso, usá la recuperación desde el inicio de sesión.')
          : 'Ingresa con tu cuenta. Si no puedes entrar, recupera el acceso desde el inicio de sesión.'}`;
      await sendTwilioWhatsAppBodyToRaw(waLic, msg);
    }

    res.json({ ok: true, sede_id: sedeId, auth_user_created: Boolean(authProvision?.created),
      access_state: authProvision.access_state, welcome_delivery: authProvision.welcome_delivery });
  } catch (err) {
    console.error('❌ POST /api/admin/sedes-directa:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.get('/api/admin/sedes-pendientes', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.email) return res.status(401).json({ error: 'No autorizado' });
    const rowRole = await fetchUserRoleRow(user);
    const role = rowRole?.role || null;
    if (!isSuperAdminApi(user.email, role)) {
      return res.status(403).json({ error: 'Solo super admin' });
    }
    const estado = String(req.query.estado || 'pendiente').trim().toLowerCase();
    let q = supabase.from('sedes_pendientes').select('*').order('created_at', { ascending: false });
    if (estado && estado !== 'todas' && estado !== 'todos') q = q.eq('estado', estado);
    const { data, error } = await q;
    if (error) throw error;
    res.json((data || []).map(redactSedePaymentValues));
  } catch (err) {
    console.error('❌ GET /api/admin/sedes-pendientes:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

// QA probe is available with mutation capability OFF. OFF never means safe
// legacy admission: block approval until the guarded atomic path is enabled.
mountSedeQaDiagnostic(app,{pool:pgPool,runtime,authUserFromBearer,assertSuperAdminReq});
const approvalPool=createQaGuardedPool(pgPool,{runtime,env:process.env});
mountQaLegacyAdmission(app,{runtime,env:process.env,pool:approvalPool,enabled:sedeApprovalRecoveryEnabled});

// Mounted first: enabled recovery handles every approval, including failures.
// No next() or legacy fallback is allowed after an atomic approval attempt.
mountSedeApprovalRecoveryRoutes(app, {
  enabled: sedeApprovalRecoveryEnabled, pool: approvalPool, authUserFromBearer,
  assertSuperAdminReq, supabaseAdmin, runtime, frontendUrl: FRONTEND_URL,
  sendWhatsapp: sendTwilioWhatsAppBodyToRaw,
  lookupCreatorWhatsapp: email => fetchJugadorWhatsappPorEmail(email, { strict: true }),
  sendRegistrationEvent: createAcknowledgedMakeTransport({
    runtime, webhookUrl: process.env.MAKE_WEBHOOK_URL,
  }),
});

app.post('/api/admin/sedes-pendientes/:id/aprobar', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.id || !user?.email) return res.status(401).json({ error: 'No autorizado' });
    if (!await strictSuperAdminRole(supabase, user.id)) {
      return res.status(403).json({ error: 'Solo super admin' });
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido' });

    const { data: pend, error: pe } = await supabase.from('sedes_pendientes').select('*').eq('id', id).maybeSingle();
    if (pe) throw pe;
    if (!pend) return res.status(404).json({ error: 'No encontrada' });
    if (pend.estado !== 'pendiente') return res.status(400).json({ error: 'La solicitud ya no está pendiente' });

    const licEmail = normalizarEmailLicenciatario(pend.licenciatario_email);
    if (!licEmail) {
      return res.status(400).json({ error: 'Solicitud sin email de licenciatario' });
    }
    if (!emailLicenciatarioPlausible(licEmail)) {
      return res.status(400).json({ error: 'Email de licenciatario inválido' });
    }
    // Validate the seat contract and role geography before calling Auth; a
    // rejected request must not create a seat nor reach the provider.
    const sedeInsert = buildSedeReleaseInsert(mapPendingRowToSedeInsert(pend));
    const preservaAdminCadena = Boolean(
      pend.organizacion_id && licEmail === String(pend.created_by || '').trim().toLowerCase()
    );
    if (!preservaAdminCadena) validarAsignacionRolLicencia(pend);

    let authProvision;
    try {
      authProvision = await ensureLicenciatarioAuthUserAndWelcomeEmail(licEmail, {
        nombre: String(pend.licenciatario_nombre || '').trim() || null,
        pais: String(pend.pais || '').trim() || null,
        ciudad: String(pend.ciudad || '').trim() || null,
      });
    } catch (authErr) {
      console.warn('⚠️ Aprobar sede pendiente: provisión auth no disponible:', authErr?.code || authErr?.status || 'provision_failed');
      return rechazarAccesoNoDisponible(res);
    }

    // Pending row, seat, organization link and role commit together. The row
    // lock serializes duplicate approvals; no REST fallback if RPC is absent.
    if (typeof supabase.rpc !== 'function') return res.status(503).json({
      error: 'La aprobación atómica no está disponible en este entorno.', code: 'SEDE_APPROVAL_ATOMIC_UNAVAILABLE',
    });
    const expected = Object.fromEntries(Object.entries(pend).filter(([key]) => key !== 'created_at'));
    const { data: approved, error: approvalError } = await supabase.rpc('aprobar_sede_pendiente_atomica', {
      p_request_id: id, p_actor_id: user.id, p_expected: expected, p_sede: sedeInsert,
    });
    if (approvalError) {
      const missing = ['PGRST202', 'PGRST203', '42883'].includes(String(approvalError.code || ''));
      return res.status(missing ? 503 : approvalError.code === '42501' ? 403 : 500).json({
        error: missing ? 'La aprobación atómica no está disponible en este entorno.' : 'No se pudo aprobar la sede. Reintentá con esta misma solicitud.',
        code: missing ? 'SEDE_APPROVAL_ATOMIC_UNAVAILABLE' : 'SEDE_APPROVAL_ATOMIC_FAILED', retry: !missing,
      });
    }
    if (approved?.ok !== true) {
      if (approved?.reason === 'not_found') return res.status(404).json({ error: 'No encontrada' });
      if (approved?.reason === 'not_pending') return res.status(400).json({ error: 'La solicitud ya no está pendiente' });
      return res.status(409).json({ error: 'La solicitud cambió. Actualizá antes de aprobar.', code: 'SEDE_APPROVAL_CHANGED_RETRY' });
    }
    const sedeId = Number(approved.sede_id);
    if (!Number.isSafeInteger(sedeId) || sedeId <= 0) return res.status(500).json({
      error: 'No se pudo confirmar la aprobación.', code: 'SEDE_APPROVAL_BAD_RECEIPT',
    });

    const nombre = String(pend.nombre || '').trim();
    const waNacional = await fetchJugadorWhatsappPorEmail(pend.created_by);
    if (waNacional) {
      await sendTwilioWhatsAppBodyToRaw(
        waNacional,
        `✅ Sede ${nombre} aprobada en PADBOL Match.`
      );
    }
    const waLic = pend.licenciatario_telefono || pend.whatsapp;
    if (waLic) {
      await sendTwilioWhatsAppBodyToRaw(
        waLic,
        `🎉 Bienvenido a PADBOL Match. Tu sede "${nombre}" está activa.\nIngresa al panel: padbolmatch.com/admin`
      );
    }

    res.json({ ok: true, sede_id: sedeId,
      access_state: authProvision.access_state,
      welcome_delivery: authProvision.welcome_delivery });
  } catch (err) {
    console.error('❌ POST aprobar sede pendiente:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

app.post('/api/admin/sedes-pendientes/:id/rechazar', async (req, res) => {
  try {
    const user = await authUserFromBearer(req);
    if (!user?.email) return res.status(401).json({ error: 'No autorizado' });
    const rowRole = await fetchUserRoleRow(user);
    const role = rowRole?.role || null;
    if (!isSuperAdminApi(user.email, role)) {
      return res.status(403).json({ error: 'Solo super admin' });
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido' });
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Motivo obligatorio' });

    const { data: pend, error: pe } = await supabase.from('sedes_pendientes').select('*').eq('id', id).maybeSingle();
    if (pe) throw pe;
    if (!pend) return res.status(404).json({ error: 'No encontrada' });
    if (pend.estado !== 'pendiente') return res.status(400).json({ error: 'La solicitud ya no está pendiente' });

    await rejectPendingSede({ db: supabase, requestId: id, reason: motivo });

    // The state transition is already confirmed. Notification failure must
    // not turn it into a failed rejection or invite an unsafe repeat send.
    let notificationStatus = 'skipped';
    try {
      const waNacional = await fetchJugadorWhatsappPorEmail(pend.created_by, { strict: true });
      if (waNacional) {
        const nombre = String(pend.nombre || '').trim();
        const receipt = await sendTwilioWhatsAppBodyToRaw(
          waNacional,
          `❌ Sede "${nombre}" rechazada.\nMotivo: ${motivo}`
        );
        notificationStatus = receipt?.sid ? 'accepted' : 'needs_review';
      }
    } catch { notificationStatus = 'needs_review'; }
    res.json({ ok: true, notifications_pending: notificationStatus === 'needs_review', notification_status: notificationStatus });
  } catch (err) {
    console.error('❌ POST rechazar sede pendiente:', err.message);
    res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

registerAdminOrganizationsRoutes(app, {
  supabase,
  adminListScopeFromRequest,
  assertSuperAdminReq,
  generateAdminInviteMagicLink,
});

registerSedeIncentiveRoutes(app, {
  supabase: supabaseAdmin,
  adminListScopeFromRequest,
  assertUsuarioPuedeAdministrarSede,
  assertSuperAdminReq,
});
}
