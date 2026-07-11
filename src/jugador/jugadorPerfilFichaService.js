import {
  decryptDocumentoFromStorage,
} from './jugadorIdentidadCrypto.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_CIUDAD_LEN = 120;

export const PERFIL_FICHA_IDENTIDAD_INPUT_FIELDS = Object.freeze([
  'fecha_nacimiento',
  'tipo_documento',
  'numero_documento',
  'nacionalidad',
  'genero',
  'pais_documento',
]);

const IDENTIDAD_FICHA_SELECT = [
  'fecha_nacimiento',
  'tipo_documento',
  'numero_documento_cifrado',
  'nacionalidad',
  'genero',
].join(', ');

export const EMPTY_PERFIL_FICHA_IDENTIDAD = Object.freeze({
  tipo_documento: null,
  numero_documento: null,
  fecha_nacimiento: null,
  nacionalidad: null,
  genero: null,
});

function isMissingIdentidadTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('jugadores_identidad')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function assertUserId(userId) {
  const id = String(userId ?? '').trim();
  if (!UUID_REGEX.test(id)) {
    const err = new Error('userId inválido');
    err.code = 'USER_ID_INVALIDO';
    err.status = 400;
    throw err;
  }
  return id;
}

export function validateCiudad(value) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.length > MAX_CIUDAD_LEN) {
    const err = new Error('ciudad inválida');
    err.code = 'CIUDAD_INVALIDA';
    err.status = 400;
    throw err;
  }
  return trimmed;
}

export function buildIdentidadUpsertPayloadFromPerfilBody(body = {}) {
  const payload = {};
  for (const field of PERFIL_FICHA_IDENTIDAD_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      payload[field] = body[field];
    }
  }
  return payload;
}

export function perfilBodyHasIdentidadFields(body = {}) {
  return PERFIL_FICHA_IDENTIDAD_INPUT_FIELDS.some(
    (field) => Object.prototype.hasOwnProperty.call(body, field),
  );
}

export function buildPerfilFichaIdentidadFields(identidadRow) {
  if (!identidadRow) {
    return { ...EMPTY_PERFIL_FICHA_IDENTIDAD };
  }

  const plainNumero = decryptDocumentoFromStorage(identidadRow.numero_documento_cifrado);

  return {
    tipo_documento: identidadRow.tipo_documento ?? null,
    numero_documento: plainNumero || null,
    fecha_nacimiento: identidadRow.fecha_nacimiento ?? null,
    nacionalidad: identidadRow.nacionalidad ?? null,
    genero: identidadRow.genero ?? null,
  };
}

export async function fetchIdentidadForPerfil(supabaseAdmin, userId) {
  const uid = assertUserId(userId);

  const { data, error } = await supabaseAdmin
    .from('jugadores_identidad')
    .select(IDENTIDAD_FICHA_SELECT)
    .eq('user_id', uid)
    .maybeSingle();

  if (error) {
    if (isMissingIdentidadTable(error)) {
      return { ...EMPTY_PERFIL_FICHA_IDENTIDAD };
    }
    throw error;
  }

  return buildPerfilFichaIdentidadFields(data);
}

export function resolvePaisDocumentoFallback(body = {}, perfilPais = null) {
  if (Object.prototype.hasOwnProperty.call(body, 'pais_documento')) {
    return body.pais_documento;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'pais')) {
    return body.pais;
  }
  return perfilPais ?? null;
}
