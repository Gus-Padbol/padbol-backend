// These legacy NOT NULL fields still form part of the deployed schema.
// Absence is a validation error; never fabricate a price or opening hours.
export function buildSedeReleaseInsert(payload = {}) {
  const row = { ...payload };
  row.whatsapp_contacto = String(row.whatsapp_contacto || row.telefono || '').trim();
  const price = row.precio_por_reserva ?? row.precio_turno;
  if (price != null && String(price).trim() !== '') row.precio_por_reserva = Number(price);
  const courts = row.cantidad_canchas;
  if (courts != null && String(courts).trim() !== '') row.cantidad_canchas = Number(courts);
  const errors = [];
  for (const field of ['nombre','pais','ciudad','horario_apertura','horario_cierre','whatsapp_contacto']) {
    if (!String(row[field] || '').trim()) errors.push(field);
  }
  for (const field of ['horario_apertura', 'horario_cierre']) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(row[field] || '').trim())) {
      if (!errors.includes(field)) errors.push(field);
    }
  }
  if (!Number.isInteger(row.cantidad_canchas) || row.cantidad_canchas < 0) errors.push('cantidad_canchas');
  if (!Number.isInteger(row.precio_por_reserva) || row.precio_por_reserva < 0) errors.push('precio_por_reserva');
  if (errors.length) throw Object.assign(new Error(`Completa los datos de la sede: ${errors.join(', ')}`), {
    status: 400, code: 'SEDE_REQUIRED_CONFIGURATION', fields: errors,
  });
  return row;
}
