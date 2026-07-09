export const TIPOS_DOCUMENTO = Object.freeze([
  'dni',
  'pasaporte',
  'cedula',
  'otro',
]);

export const GENEROS = Object.freeze([
  'masculino',
  'femenino',
  'otro',
  'prefiero_no_decir',
]);

export const IDENTIDAD_ESTADOS = Object.freeze([
  'incompleta',
  'pendiente_revision',
  'verificada',
  'rechazada',
]);

export const TIPOS_ACEPTACION = Object.freeze([
  'terminos_servicio',
  'privacidad',
  'reglamento_torneo',
  'padbol_match',
]);

export const MIN_EDAD_ANIOS = 5;
export const MAX_EDAD_ANIOS = 120;
export const MAX_PAIS_TEXTO_LEN = 64;
export const MAX_TELEFONO_LEN = 32;
export const MAX_NOMBRE_CONTACTO_LEN = 120;
export const MAX_RELACION_LEN = 64;
export const MAX_CATEGORIA_LEN = 64;
export const MIN_NUMERO_DOCUMENTO_LEN = 4;
export const MAX_NUMERO_DOCUMENTO_LEN = 32;
