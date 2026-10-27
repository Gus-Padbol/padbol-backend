const PAGE_SIZE = 100;
const MAX_ROWS = 10000;

// Page by immutable primary key; a server-side response cap cannot silently truncate the result.
export async function readWaitlistForSede(db, table, sedeId) {
  let lastId = null;
  const rows = [];
  while (true) {
    let query = db.from(table)
      .select('id, sede_id, user_id, deporte, created_at')
      .eq('sede_id', sedeId);
    if (lastId !== null) query = query.gt('id', lastId);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Respuesta inválida de lista de espera');
    if (!data.length) break;
    if (rows.length + data.length > MAX_ROWS) {
      const err = new Error('La lista supera el límite de consulta; requiere paginación');
      err.status = 503;
      throw err;
    }
    const next = data[data.length - 1].id;
    if ((typeof next !== 'string' || !next) && (typeof next !== 'number' || !Number.isSafeInteger(next))) throw new Error('Identificador inválido de lista de espera');
    if (next === lastId) throw new Error('Orden inválido de lista de espera');
    rows.push(...data);
    lastId = next;
  }
  return rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.id).localeCompare(String(a.id)));
}

export async function readWaitlistProfiles(db, userIds, columns) {
  const map = new Map();
  for (let i = 0; i < userIds.length; i += PAGE_SIZE) {
    const batch = userIds.slice(i, i + PAGE_SIZE);
    let lastId = null;
    while (true) {
      let query = db.from('jugadores_perfil').select(columns).in('user_id', batch)
        .order('user_id', { ascending: true }).limit(PAGE_SIZE);
      if (lastId) query = query.gt('user_id', lastId);
      const { data, error } = await query;
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Respuesta inválida de perfiles');
      if (!data.length) break;
      const next = String(data[data.length - 1].user_id || '');
      if (!next || (lastId && next <= lastId)) throw new Error('Orden inválido de perfiles');
      for (const profile of data) if (profile.user_id) map.set(String(profile.user_id), profile);
      lastId = next;
    }
  }
  return map;
}
