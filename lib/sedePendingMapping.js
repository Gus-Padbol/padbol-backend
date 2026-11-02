import { DateTime } from 'luxon';

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

function normalizeMetodoPago(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'stripe') return 'stripe';
  if (v === 'manual') return 'manual';
  if (v === 'efectivo') return 'efectivo';
  return 'mercadopago';
}

export function mapPendingRowToSedeInsert(row) {
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
