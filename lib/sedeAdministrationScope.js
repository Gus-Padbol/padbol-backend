// Alcance de administración por sede.
// Política vigente: super_admin global; admin_club solo sus sedes; admin_nacional
// (coordinador de país) solo las sedes de su país, y solo con alcance "pais".
// Cualquier combinación no prevista se rechaza.

export function normalizeCountry(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function canAdministerSede({ role, sede } = {}) {
  const rol = String(role?.rol || '').trim().toLowerCase();
  if (rol === 'super_admin') return true;
  const sedeId = Number(sede?.id ?? sede?.sede_id);
  if (rol === 'admin_club') {
    return role?.sede_id != null && Number.isFinite(sedeId) && Number(role.sede_id) === sedeId;
  }
  if (rol === 'admin_nacional') {
    // El coordinador territorial solo administra su país; nunca por sede suelta.
    if (String(role?.alcance || '').trim().toLowerCase() !== 'pais') return false;
    const rolePais = normalizeCountry(role?.pais);
    const sedePais = normalizeCountry(sede?.pais);
    return Boolean(rolePais && sedePais && rolePais === sedePais);
  }
  return false;
}

export function forbiddenSede() {
  const error = new Error('No tenés permiso para administrar esta sede');
  error.status = 403;
  return error;
}

// fetchSede debe devolver { id, pais } o null. Una sede inexistente no habilita
// el alcance territorial: solo super_admin y el club con sede asignada siguen igual.
export async function assertCanAdministerSede({ role, sedeId, fetchSede } = {}) {
  const rol = String(role?.rol || '').trim().toLowerCase();
  if (rol === 'super_admin') return { id: Number(sedeId) };
  if (rol === 'admin_club') {
    if (role?.sede_id != null && Number(role.sede_id) === Number(sedeId)) return { id: Number(sedeId) };
    throw forbiddenSede();
  }
  if (rol === 'admin_nacional') {
    const sede = typeof fetchSede === 'function' ? await fetchSede(sedeId) : null;
    const resolved = sede ? { id: Number(sede.id ?? sedeId), pais: sede.pais } : { id: Number(sedeId), pais: null };
    if (canAdministerSede({ role, sede: resolved })) return resolved;
    throw forbiddenSede();
  }
  throw forbiddenSede();
}
