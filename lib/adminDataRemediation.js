const normalize = (value) => String(value || '').trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const DATA_FINDINGS = Object.freeze({
  'S-01': { table: 'sedes', mutableFields: [] },
  'S-03': { table: 'sedes_duraciones', mutableFields: ['precio', 'activo'] },
  'G-06': { table: null, mutableFields: [] },
  'ME-01': { table: 'membresia_planes', mutableFields: ['moneda', 'descripcion', 'activo', 'vigencia_hasta'] },
  'T-02': { table: 'torneos', mutableFields: ['estado'] },
});

export function findSedeDuplicateCandidates(rows = []) {
  const tokens = (name) => normalize(name).replace(/\b(padbol|club)\b/g, '').replace(/\s+/g, ' ').trim();
  const groups = new Map();
  for (const row of rows) {
    const key = tokens(row?.nombre);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()].filter(([, matches]) => matches.length > 1)
    .map(([key, matches]) => ({ key, matches }));
}

export function findDurationDuplicateCandidates(rows = []) {
  const groups = new Map();
  for (const row of rows.filter((item) => item?.activo !== false)) {
    const key = `${row.sede_id}:${row.duracion_minutos}:${normalize(row.deporte || 'padbol')}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()].filter(([, matches]) => matches.length > 1)
    .map(([key, matches]) => ({ key, prices: [...new Set(matches.map((row) => Number(row.precio)))], matches }));
}

export function findExpiredTournamentCandidates(rows = [], now = new Date()) {
  const timestamp = now.getTime();
  return rows.filter((row) => normalize(row?.estado) === 'en curso'
    && row?.fecha_fin && new Date(row.fecha_fin).getTime() < timestamp);
}

export function findMembershipPlanCandidates(rows = [], now = new Date()) {
  const timestamp = now.getTime();
  return rows.filter((row) => (row?.activo === true && row?.vigencia_hasta
      && new Date(row.vigencia_hasta).getTime() < timestamp)
    || (row?.sede_pais && normalize(row.sede_pais).includes('argentin') && normalize(row.moneda) !== 'ars'));
}

export function validateMutationRequest({ finding, id, fields = {}, deleteRow = false, confirmId }) {
  const spec = DATA_FINDINGS[finding];
  if (!spec) return { ok: false, error: 'finding_no_soportado' };
  if (!id || String(id).trim() === '') return { ok: false, error: 'id_explicito_requerido' };
  if (String(confirmId || '') !== String(id)) return { ok: false, error: 'confirm_id_debe_coincidir' };
  if (finding === 'S-01') return { ok: false, error: 'fusion_sede_requiere_transaccion_humana' };
  if (deleteRow) {
    if (finding !== 'G-06') return { ok: false, error: 'borrado_no_permitido_para_hallazgo' };
    return { ok: true, deleteRow: true };
  }
  const entries = Object.entries(fields);
  if (!entries.length) return { ok: false, error: 'valor_explicito_requerido' };
  if (entries.some(([key]) => !spec.mutableFields.includes(key))) return { ok: false, error: 'campo_no_permitido' };
  return { ok: true, fields: Object.fromEntries(entries) };
}
