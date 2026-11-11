/** Read-only completeness check for the official player profile required by Naples enrollment. */
import { readAuthenticatedPlayerProfile } from './authenticatedPlayerProfile.js';
import { getIdentidadPropia } from '../src/jugador/jugadorIdentidadService.js';

const REQUIRED_PROFILE = [
  ['nombre', 'nombre'],
  ['apellido', 'apellido'],
  ['pais', 'pais'],
  ['ciudad', 'ciudad'],
  ['nivel', 'nivel'],
  ['lateralidad', 'lateralidad'],
  ['posicion_cancha', 'posicion_cancha'],
];
const REQUIRED_IDENTITY = [
  ['fecha_nacimiento', 'fecha_nacimiento'],
  ['tipo_documento', 'tipo_documento'],
  ['nacionalidad', 'nacionalidad'],
  ['genero', 'genero'],
  ['pais_documento', 'pais_documento'],
  ['categoria_deportiva', 'categoria_deportiva'],
];

const text = (value) => String(value ?? '').trim();

/**
 * Returns only booleans/field names; never returns document numbers, contacts,
 * account IDs or other profile values. Missing history/points is not part of this gate.
 */
export async function readNationsFichaReadiness({ supabaseAdmin, user } = {}) {
  if (!supabaseAdmin || !user?.id) {
    const error = new Error('No se pudo comprobar la ficha del jugador.');
    error.code = 'PROFILE_READINESS_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  const profile = await readAuthenticatedPlayerProfile(supabaseAdmin, user);
  const identity = await getIdentidadPropia(supabaseAdmin, user.id);
  const missing = [];
  for (const [key] of REQUIRED_PROFILE) if (!text(profile?.[key])) missing.push(key);
  const phone = text(profile?.telefono) || text(profile?.whatsapp) || text(identity?.telefono);
  if (!phone) missing.push('telefono');
  if (!text(profile?.email) && !text(user.email)) missing.push('email');
  for (const [key] of REQUIRED_IDENTITY) if (!text(identity?.[key])) missing.push(key);
  if (identity?.completitud?.documento_completo !== true) missing.push('numero_documento');
  return { complete: missing.length === 0, missing };
}
