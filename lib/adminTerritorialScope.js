/** Geographic authorization requires every parent, never a matching name alone. */
const TERRITORY_FIELDS = {
  __proto__: null,
  pais: ['pais'],
  provincia: ['pais', 'provincia'],
  ciudad: ['pais', 'provincia', 'ciudad'],
};

export function normalizeGeoText(raw) {
  return String(raw || '')
    .replace(/^[\p{Emoji_Presentation}\s]*/u, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function scopeValue(scope, field) {
  const value = scope?.[`${field}Norm`] ?? scope?.[field];
  return typeof value === 'string' ? normalizeGeoText(value) : '';
}

export function hasCompleteTerritorialScope(scope) {
  const fields = TERRITORY_FIELDS[scope?.alcance];
  return Boolean(fields && fields.every((field) => scopeValue(scope, field)));
}

export function filterSedesByTerritorialScope(scope, sedes) {
  if (!hasCompleteTerritorialScope(scope)) return [];
  return (sedes || []).filter((sede) => TERRITORY_FIELDS[scope.alcance].every((field) => (
    typeof sede?.[field] === 'string' &&
    normalizeGeoText(sede[field]) === scopeValue(scope, field)
  )));
}

export function buildAdminRoleGeography(alcance, input = {}) {
  const geography = { pais: null, provincia: null, ciudad: null };
  for (const field of TERRITORY_FIELDS[alcance] || []) {
    const value = typeof input[field] === 'string' ? input[field].trim() : '';
    if (!normalizeGeoText(value)) {
      const label = { pais: 'País', provincia: 'Provincia / estado', ciudad: 'Ciudad' }[field];
      const error = new Error(`${label} obligatorio para alcance ${alcance}`);
      error.status = 400;
      error.code = 'ADMIN_TERRITORY_INCOMPLETE';
      throw error;
    }
    geography[field] = value;
  }
  return geography;
}

export async function resolveSedesPermitidasPorScope(supabase, scope) {
  if (!scope) return { mode: 'none', sedes: [] };
  if (String(scope.rol || '').trim().toLowerCase() === 'editor_contenido') {
    return { mode: 'none', sedes: [] };
  }
  if (scope.superA || scope.alcance === 'global') {
    const { data, error } = await supabase.from('sedes').select('*');
    if (error) throw error;
    return { mode: 'global', sedes: data || [] };
  }
  const alcance = scope.alcance || 'sede';
  if (alcance === 'sede' && scope.sedeId != null) {
    const { data, error } = await supabase.from('sedes').select('*').eq('id', scope.sedeId);
    if (error) throw error;
    return { mode: 'sede', sedes: data || [] };
  }
  if (alcance === 'organizacion' && scope.organizacionId) {
    const { data: organization, error: organizationError } = await supabase
      .from('organizaciones').select('id, estado').eq('id', scope.organizacionId).maybeSingle();
    if (organizationError) throw organizationError;
    if (!organization || organization.estado !== 'activa') return { mode: 'none', sedes: [] };
    const { data: links, error: linksError } = await supabase
      .from('organizacion_sedes')
      .select('sede_id')
      .eq('organizacion_id', scope.organizacionId);
    if (linksError) throw linksError;
    const sedeIds = (links || []).map((row) => Number(row.sede_id)).filter(Number.isFinite);
    if (!sedeIds.length) return { mode: 'organizacion', sedes: [] };
    const { data, error } = await supabase.from('sedes').select('*').in('id', sedeIds);
    if (error) throw error;
    return { mode: 'organizacion', sedes: data || [] };
  }
  // Legacy incomplete assignments must be corrected explicitly by a super admin.
  if (!hasCompleteTerritorialScope(scope)) return { mode: alcance, sedes: [] };
  const { data, error } = await supabase.from('sedes').select('*');
  if (error) throw error;
  return { mode: alcance, sedes: filterSedesByTerritorialScope(scope, data) };
}
