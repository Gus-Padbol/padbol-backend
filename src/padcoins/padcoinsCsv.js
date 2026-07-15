/**
 * Utilidades CSV para reportes PadCoins (UTF-8 compatible Excel/Numbers).
 * Protege inyección CSV (=, +, -, @) y evita datos sensibles en el serializador.
 */

const CSV_INJECTION_PREFIX = /^[=+\-@]/;

export const PADCOINS_CSV_BOM = '\uFEFF';
export const PADCOINS_CSV_MAX_EXPORT_ROWS = 5000;

export function escapePadcoinsCsvCell(value) {
  if (value == null) return '';
  let text = String(value);
  // Neutralizar fórmulas / CSV injection
  if (CSV_INJECTION_PREFIX.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildPadcoinsCsvContent(headers, rows) {
  const lines = [];
  lines.push(headers.map(escapePadcoinsCsvCell).join(','));
  for (const row of rows) {
    lines.push(headers.map((header) => escapePadcoinsCsvCell(row[header])).join(','));
  }
  return `${PADCOINS_CSV_BOM}${lines.join('\r\n')}\r\n`;
}

export function buildPadcoinsCsvFilename(tipo, { sedeId = null, fecha = null } = {}) {
  const day = fecha
    ? String(fecha).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const sedePart = sedeId != null ? `sede-${sedeId}` : 'sede-todas';
  const safeTipo = String(tipo || 'reporte').replace(/[^a-z0-9_-]/gi, '');
  return `padcoins-${safeTipo}_${sedePart}_${day}.csv`;
}

export function assertPadcoinsExportWithinLimit(total, max = PADCOINS_CSV_MAX_EXPORT_ROWS) {
  const n = Number(total) || 0;
  if (n > max) {
    const err = new Error(
      `La exportación supera el límite de ${max} filas (total=${n}). Acotá filtros de sede o fecha.`,
    );
    err.status = 400;
    err.code = 'PADCOINS_EXPORT_LIMIT_EXCEEDED';
    throw err;
  }
}
