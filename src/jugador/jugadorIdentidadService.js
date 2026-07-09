import { createHash } from 'node:crypto';
import {
  GENEROS,
  IDENTIDAD_ESTADOS,
  MAX_CATEGORIA_LEN,
  MAX_EDAD_ANIOS,
  MAX_NOMBRE_CONTACTO_LEN,
  MAX_NUMERO_DOCUMENTO_LEN,
  MAX_PAIS_TEXTO_LEN,
  MAX_RELACION_LEN,
  MAX_TELEFONO_LEN,
  MIN_EDAD_ANIOS,
  MIN_NUMERO_DOCUMENTO_LEN,
  TIPOS_DOCUMENTO,
} from './jugadorIdentidadConfig.js';
import {
  decryptDocumentoFromStorage,
  encryptDocumentoForStorage,
  hasIdentidadEncryptionKey,
} from './jugadorIdentidadCrypto.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDENTIDAD_SELECT = [
  'user_id',
  'fecha_nacimiento',
  'tipo_documento',
  'pais_documento',
  'numero_documento_cifrado',
  'numero_documento_hash',
  'nacionalidad',
  'genero',
  'categoria_deportiva',
  'telefono',
  'telefono_verificado_at',
  'contacto_emergencia_nombre',
  'contacto_emergencia_telefono',
  'contacto_emergencia_relacion',
  'identidad_estado',
  'identidad_verificada_at',
  'identidad_verificada_por',
  'identidad_notas_admin',
  'created_at',
  'updated_at',
].join(', ');

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function assertUserId(userId) {
  const id = String(userId ?? '').trim();
  if (!UUID_REGEX.test(id)) {
    const err = new Error('userId inválido');
    err.code = 'USER_ID_INVALIDO';
    throw err;
  }
  return id;
}

function validationError(message, code) {
  const err = new Error(message);
  err.code = code ?? 'VALIDACION_IDENTIDAD';
  err.status = 400;
  throw err;
}

export function normalizeDocumento(tipo, pais, numero) {
  const tipoNorm = String(tipo ?? '').trim().toLowerCase();
  const paisNorm = String(pais ?? '').trim().toUpperCase();
  const numeroNorm = String(numero ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s.\-/]/g, '');

  return {
    tipo: tipoNorm,
    pais: paisNorm,
    numero: numeroNorm,
  };
}

export function hashDocumento(tipo, pais, numero) {
  const normalized = normalizeDocumento(tipo, pais, numero);
  if (!normalized.tipo || !normalized.pais || !normalized.numero) return null;

  const material = `${normalized.tipo}|${normalized.pais}|${normalized.numero}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export function maskDocumento(numero) {
  const digits = String(numero ?? '').replace(/\D/g, '');
  if (!digits) {
    const raw = String(numero ?? '').trim();
    if (!raw) return { masked: null, last4: null };
    const last4 = raw.slice(-4);
    return {
      masked: last4 ? `${'*'.repeat(Math.max(0, raw.length - 4))}${last4}` : null,
      last4: last4 || null,
    };
  }

  const last4 = digits.slice(-4);
  return {
    masked: `${'*'.repeat(Math.max(0, digits.length - 4))}${last4}`,
    last4,
  };
}

function validateTipoDocumento(tipo) {
  if (!TIPOS_DOCUMENTO.includes(String(tipo ?? '').trim().toLowerCase())) {
    validationError(`tipo_documento inválido. Permitidos: ${TIPOS_DOCUMENTO.join(', ')}`, 'TIPO_DOCUMENTO_INVALIDO');
  }
}

function validateGenero(genero) {
  if (genero == null || genero === '') return;
  if (!GENEROS.includes(String(genero).trim().toLowerCase())) {
    validationError(`genero inválido. Permitidos: ${GENEROS.join(', ')}`, 'GENERO_INVALIDO');
  }
}

function validatePaisTexto(value, fieldName) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > MAX_PAIS_TEXTO_LEN) {
    validationError(`${fieldName} inválido`, `${fieldName.toUpperCase()}_INVALIDO`);
  }
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s\-'.]{2,}$/.test(trimmed) && !/^[A-Z]{2,3}$/.test(trimmed)) {
    validationError(`${fieldName} inválido`, `${fieldName.toUpperCase()}_INVALIDO`);
  }
  return trimmed;
}

function validateTelefono(value, fieldName = 'telefono') {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > MAX_TELEFONO_LEN) {
    validationError(`${fieldName} inválido`, `${fieldName.toUpperCase()}_INVALIDO`);
  }
  if (!/^\+?[0-9()\s\-]{6,}$/.test(trimmed)) {
    validationError(`${fieldName} inválido`, `${fieldName.toUpperCase()}_INVALIDO`);
  }
  return trimmed;
}

function validateOptionalText(value, maxLen, fieldName) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > maxLen) {
    validationError(`${fieldName} inválido`, `${fieldName.toUpperCase()}_INVALIDO`);
  }
  return trimmed;
}

export function validateFechaNacimiento(raw) {
  if (raw == null || raw === '') return null;

  const dateStr = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    validationError('fecha_nacimiento debe ser YYYY-MM-DD', 'FECHA_NACIMIENTO_INVALIDA');
  }

  const date = new Date(`${dateStr}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    validationError('fecha_nacimiento inválida', 'FECHA_NACIMIENTO_INVALIDA');
  }

  const now = new Date();
  if (date > now) {
    validationError('fecha_nacimiento no puede ser futura', 'FECHA_NACIMIENTO_INVALIDA');
  }

  const ageMs = now.getTime() - date.getTime();
  const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < MIN_EDAD_ANIOS || ageYears > MAX_EDAD_ANIOS) {
    validationError('fecha_nacimiento fuera de rango permitido', 'FECHA_NACIMIENTO_INVALIDA');
  }

  return dateStr;
}

function validateNumeroDocumento(numero) {
  const normalized = String(numero ?? '').trim().toUpperCase().replace(/[\s.\-/]/g, '');
  if (!normalized) {
    validationError('numero_documento requerido', 'NUMERO_DOCUMENTO_INVALIDO');
  }
  if (normalized.length < MIN_NUMERO_DOCUMENTO_LEN || normalized.length > MAX_NUMERO_DOCUMENTO_LEN) {
    validationError('numero_documento inválido', 'NUMERO_DOCUMENTO_INVALIDO');
  }
  if (!/^[A-Z0-9]+$/.test(normalized)) {
    validationError('numero_documento inválido', 'NUMERO_DOCUMENTO_INVALIDO');
  }
  return normalized;
}

function hasDocumentoCompleto(row) {
  return Boolean(
    row?.tipo_documento
    && row?.pais_documento
    && row?.numero_documento_hash,
  );
}

function hasIdentidadMinima(row) {
  return Boolean(row?.fecha_nacimiento && hasDocumentoCompleto(row));
}

function resolveEstadoAfterUpsert(existing, merged, documentoChanged) {
  if (!hasIdentidadMinima(merged)) {
    return 'incompleta';
  }

  if (documentoChanged) {
    return 'pendiente_revision';
  }

  if (existing?.identidad_estado === 'verificada' || existing?.identidad_estado === 'rechazada') {
    return existing.identidad_estado;
  }

  if (existing?.identidad_estado === 'pendiente_revision') {
    return 'pendiente_revision';
  }

  return 'pendiente_revision';
}

export function buildIdentidadPropiaResponse(row) {
  if (!row) {
    return {
      identidad_estado: 'incompleta',
      fecha_nacimiento: null,
      tipo_documento: null,
      pais_documento: null,
      numero_documento_masked: null,
      numero_documento_last4: null,
      nacionalidad: null,
      genero: null,
      categoria_deportiva: null,
      telefono: null,
      telefono_verificado_at: null,
      contacto_emergencia_nombre: null,
      contacto_emergencia_telefono: null,
      contacto_emergencia_relacion: null,
      updated_at: null,
      completitud: {
        documento_completo: false,
        identidad_minima_completa: false,
        pendiente_cifrado_fuerte: !hasIdentidadEncryptionKey(),
      },
    };
  }

  const plainNumero = decryptDocumentoFromStorage(row.numero_documento_cifrado);
  const { masked, last4 } = maskDocumento(plainNumero);

  return {
    identidad_estado: row.identidad_estado ?? 'incompleta',
    fecha_nacimiento: row.fecha_nacimiento ?? null,
    tipo_documento: row.tipo_documento ?? null,
    pais_documento: row.pais_documento ?? null,
    numero_documento_masked: masked,
    numero_documento_last4: last4,
    nacionalidad: row.nacionalidad ?? null,
    genero: row.genero ?? null,
    categoria_deportiva: row.categoria_deportiva ?? null,
    telefono: row.telefono ?? null,
    telefono_verificado_at: row.telefono_verificado_at ?? null,
    contacto_emergencia_nombre: row.contacto_emergencia_nombre ?? null,
    contacto_emergencia_telefono: row.contacto_emergencia_telefono ?? null,
    contacto_emergencia_relacion: row.contacto_emergencia_relacion ?? null,
    updated_at: row.updated_at ?? null,
    completitud: {
      documento_completo: hasDocumentoCompleto(row),
      identidad_minima_completa: hasIdentidadMinima(row),
      pendiente_cifrado_fuerte: !hasIdentidadEncryptionKey(),
    },
  };
}

export async function getIdentidadPropia(supabaseAdmin, userId) {
  const uid = assertUserId(userId);

  const { data, error } = await supabaseAdmin
    .from('jugadores_identidad')
    .select(IDENTIDAD_SELECT)
    .eq('user_id', uid)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      const err = new Error('Tabla jugadores_identidad no disponible. Ejecutar migración SQL.');
      err.code = 'IDENTIDAD_TABLA_NO_DISPONIBLE';
      err.status = 503;
      throw err;
    }
    throw error;
  }

  return buildIdentidadPropiaResponse(data);
}

function parseUpsertPayload(payload = {}) {
  const parsed = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'fecha_nacimiento')) {
    parsed.fecha_nacimiento = validateFechaNacimiento(payload.fecha_nacimiento);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'tipo_documento')) {
    const tipo = String(payload.tipo_documento ?? '').trim().toLowerCase();
    if (tipo) {
      validateTipoDocumento(tipo);
      parsed.tipo_documento = tipo;
    } else {
      parsed.tipo_documento = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'pais_documento')) {
    parsed.pais_documento = validatePaisTexto(payload.pais_documento, 'pais_documento');
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'nacionalidad')) {
    parsed.nacionalidad = validatePaisTexto(payload.nacionalidad, 'nacionalidad');
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'genero')) {
    const genero = payload.genero == null || payload.genero === ''
      ? null
      : String(payload.genero).trim().toLowerCase();
    if (genero) validateGenero(genero);
    parsed.genero = genero;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'categoria_deportiva')) {
    parsed.categoria_deportiva = validateOptionalText(
      payload.categoria_deportiva,
      MAX_CATEGORIA_LEN,
      'categoria_deportiva',
    );
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'telefono')) {
    parsed.telefono = validateTelefono(payload.telefono);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'contacto_emergencia_nombre')) {
    parsed.contacto_emergencia_nombre = validateOptionalText(
      payload.contacto_emergencia_nombre,
      MAX_NOMBRE_CONTACTO_LEN,
      'contacto_emergencia_nombre',
    );
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'contacto_emergencia_telefono')) {
    parsed.contacto_emergencia_telefono = validateTelefono(
      payload.contacto_emergencia_telefono,
      'contacto_emergencia_telefono',
    );
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'contacto_emergencia_relacion')) {
    parsed.contacto_emergencia_relacion = validateOptionalText(
      payload.contacto_emergencia_relacion,
      MAX_RELACION_LEN,
      'contacto_emergencia_relacion',
    );
  }

  return parsed;
}

export async function upsertIdentidadPropia(supabaseAdmin, userId, payload = {}) {
  const uid = assertUserId(userId);

  if (payload.user_id && String(payload.user_id) !== uid) {
    validationError('No se puede modificar identidad de otro usuario', 'USER_ID_NO_PERMITIDO');
  }

  const parsed = parseUpsertPayload(payload);
  const hasDocumentoInput = Object.prototype.hasOwnProperty.call(payload, 'numero_documento');

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('jugadores_identidad')
    .select(IDENTIDAD_SELECT)
    .eq('user_id', uid)
    .maybeSingle();

  if (fetchError) {
    if (isMissingTable(fetchError)) {
      const err = new Error('Tabla jugadores_identidad no disponible. Ejecutar migración SQL.');
      err.code = 'IDENTIDAD_TABLA_NO_DISPONIBLE';
      err.status = 503;
      throw err;
    }
    throw fetchError;
  }

  const updateRow = { ...parsed };
  let documentoChanged = false;

  if (hasDocumentoInput) {
    const numero = validateNumeroDocumento(payload.numero_documento);
    const tipo = parsed.tipo_documento ?? existing?.tipo_documento;
    const pais = parsed.pais_documento ?? existing?.pais_documento;

    if (!tipo || !pais) {
      validationError(
        'tipo_documento y pais_documento son requeridos al guardar numero_documento',
        'DOCUMENTO_INCOMPLETO',
      );
    }

    validateTipoDocumento(tipo);
    const normalized = normalizeDocumento(tipo, pais, numero);
    const docHash = hashDocumento(normalized.tipo, normalized.pais, normalized.numero);

    updateRow.numero_documento_hash = docHash;
    updateRow.numero_documento_cifrado = encryptDocumentoForStorage(normalized.numero);

    documentoChanged = !existing
      || existing.numero_documento_hash !== docHash
      || existing.tipo_documento !== normalized.tipo
      || existing.pais_documento !== normalized.pais;
  }

  const mergedPreview = {
    ...(existing ?? {}),
    ...updateRow,
  };

  updateRow.identidad_estado = resolveEstadoAfterUpsert(existing, mergedPreview, documentoChanged);
  updateRow.updated_at = new Date().toISOString();

  if (documentoChanged && (existing?.identidad_estado === 'verificada' || existing?.identidad_estado === 'rechazada')) {
    updateRow.identidad_verificada_at = null;
    updateRow.identidad_verificada_por = null;
    updateRow.identidad_notas_admin = null;
  }

  const upsertPayload = {
    user_id: uid,
    ...updateRow,
  };

  if (!existing) {
    upsertPayload.created_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from('jugadores_identidad')
    .upsert(upsertPayload, { onConflict: 'user_id' })
    .select(IDENTIDAD_SELECT)
    .single();

  if (error) {
    if (error.code === '23505' && String(error.message ?? '').includes('numero_documento_hash')) {
      const err = new Error('El documento ya está registrado en otra cuenta');
      err.code = 'DOCUMENTO_DUPLICADO';
      err.status = 409;
      throw err;
    }
    if (isMissingTable(error)) {
      const err = new Error('Tabla jugadores_identidad no disponible. Ejecutar migración SQL.');
      err.code = 'IDENTIDAD_TABLA_NO_DISPONIBLE';
      err.status = 503;
      throw err;
    }
    throw error;
  }

  return buildIdentidadPropiaResponse(data);
}

export function isIdentidadEstadoValid(estado) {
  return IDENTIDAD_ESTADOS.includes(String(estado ?? '').trim());
}
