import { createHash } from 'node:crypto';

export const IMPORT_FIELDS = ['externalId', 'name', 'email', 'phone'];
const providers = new Set(['playtomic', 'matchi', 'generic']);
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }

// Column names are deliberately selected by the operator: vendors localize exports.
export function parseCustomerCsv(text, delimiter = ',') {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000) invalid('Archivo demasiado grande. Máximo 2 MB.');
  if (![',', ';', '\t'].includes(delimiter)) invalid('Separador no válido.');
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], value = '', quoted = false, closed = false;
  const cell = () => { row.push(value); value = ''; closed = false; };
  const line = () => { cell(); if (row.some(v => v !== '')) rows.push(row); row = []; if (rows.length > 5001) invalid('Máximo 5000 clientes por archivo.'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
      else value += c;
    } else if (c === delimiter) cell();
    else if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; line(); }
    else if (c === '"' && !value && !closed) quoted = true;
    else { if (closed || c === '"') invalid('CSV mal formado. Revisá las comillas.'); value += c; }
    if (value.length > 10000 || row.length > 100) invalid('Celda o cantidad de columnas demasiado grande.');
  }
  if (quoted) invalid('CSV con comillas sin cerrar.');
  if (value || row.length || closed) line();
  return rows;
}

export function previewCustomerImport({ provider, rows, mapping }) {
  if (!providers.has(provider)) invalid('Proveedor no compatible.');
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 5001) invalid('Se necesitan encabezados y entre 1 y 5000 clientes.');
  if (Buffer.byteLength(JSON.stringify(rows)) > 2_000_000 || rows.some(row => !Array.isArray(row) || row.some(v => v != null && !['string', 'number'].includes(typeof v)))) invalid('Datos de archivo no válidos o demasiado grandes.');
  const headers = rows[0];
  if (!Array.isArray(headers) || headers.length > 100 || !headers.length) invalid('Encabezados no válidos.');
  if (!mapping || !Number.isInteger(mapping.name)) invalid('Seleccioná la columna de nombre.');
  const indices = Object.entries(mapping);
  if (indices.some(([key, v]) => !IMPORT_FIELDS.includes(key) || !Number.isInteger(v) || v < 0 || v >= headers.length)
    || new Set(indices.map(([, v]) => v)).size !== indices.length) invalid('Asignación de columnas no válida.');
  if (mapping.externalId == null && mapping.email == null) invalid('Seleccioná un identificador de origen o email.');
  const customers = [], errors = [], seen = new Set(), emails = new Set();
  let duplicates = 0;
  rows.slice(1).forEach((row, offset) => {
    const number = offset + 2;
    if (!Array.isArray(row) || row.length !== headers.length) { errors.push({ row: number, reason: 'Cantidad de columnas distinta del encabezado.' }); return; }
    const record = Object.fromEntries(IMPORT_FIELDS.map(key => [key, mapping[key] == null ? '' : String(row[mapping[key]] ?? '').trim()]));
    record.email = record.email.toLowerCase();
    if (Object.values(record).some(v => v.length > 254 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))) { errors.push({ row: number, reason: 'Campo demasiado largo o con caracteres no válidos.' }); return; }
    if (!record.name || (!record.externalId && !record.email)) { errors.push({ row: number, reason: 'Falta nombre o identificador/email.' }); return; }
    if (record.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) { errors.push({ row: number, reason: 'Email no válido.' }); return; }
    // Preserve phone spelling; never guess a country or rewrite Argentine numbers.
    const key = record.externalId ? `id:${record.externalId}` : `email:${record.email}`;
    if (seen.has(key) || record.email && emails.has(record.email)) { duplicates += 1; errors.push({ row: number, reason: 'Cliente repetido en el archivo; requiere revisión.' }); return; }
    seen.add(key); if (record.email) emails.add(record.email);
    customers.push({ ...record, sourceKey: key });
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({ provider, customers })).digest('hex');
  return { provider, fingerprint, customers, duplicates, errors, canConfirm: errors.length === 0 && customers.length > 0,
    ignoredColumns: headers.filter((_, i) => !indices.some(([, index]) => index === i)),
    notice: 'Importa contactos de la sede. No crea cuentas, no envía mensajes ni acredita saldos, puntos o consentimientos comerciales.' };
}

export async function saveCustomerImport({ pool, venueId, actorId, input, fingerprint }) {
  if (!Number.isSafeInteger(venueId) || venueId <= 0 || !actorId) invalid('Sede y responsable obligatorios.');
  const preview = previewCustomerImport(input);
  if (!preview.canConfirm || fingerprint !== preview.fingerprint) invalid('Revisá y confirmá la vista previa del archivo actual.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout = '15s'");
    await db.query('SELECT pg_advisory_xact_lock(72419, $1::integer)', [venueId]);
    let inserted = 0, unchanged = 0;
    for (const customer of preview.customers) {
      const existing = await db.query('SELECT source_key, name, email, phone FROM public.club_imported_contacts WHERE sede_id=$1 AND provider=$2 AND source_key=$3 FOR UPDATE', [venueId, input.provider, customer.sourceKey]);
      if (existing.rows.length) {
        const old = existing.rows[0];
        if (old.name !== customer.name || old.email !== customer.email || old.phone !== customer.phone) invalid('Un contacto importado cambió. Revisá el conflicto antes de actualizarlo.');
        unchanged++; continue;
      }
      if (customer.email) {
        const duplicate = await db.query('SELECT 1 FROM public.club_imported_contacts WHERE sede_id=$1 AND email=$2 LIMIT 1', [venueId, customer.email]);
        if (duplicate.rows.length) invalid('El email ya está importado con otro identificador u origen. Requiere revisión.');
      }
      await db.query('INSERT INTO public.club_imported_contacts (sede_id,provider,source_key,name,email,phone,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [venueId, input.provider, customer.sourceKey, customer.name, customer.email, customer.phone, actorId]);
      inserted++;
    }
    await db.query('INSERT INTO public.club_import_batches (sede_id,provider,fingerprint,created_by,inserted_count) VALUES ($1,$2,$3,$4,$5)', [venueId, input.provider, fingerprint, actorId, inserted]);
    await db.query('COMMIT');
    return { inserted, unchanged };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
