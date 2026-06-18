/** Stripe zero-decimal currencies — amount is in whole units, not ×100. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export function normalizeStripeCurrency(moneda) {
  return String(moneda || 'USD').trim().toLowerCase();
}

export function toStripeMinorUnits(moneda, amountMajor) {
  const currency = normalizeStripeCurrency(moneda);
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) return 0;
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return Math.round(n);
  return Math.round(n * 100);
}

export function fromStripeMinorUnits(moneda, minorUnits) {
  const currency = normalizeStripeCurrency(moneda);
  const n = Number(minorUnits);
  if (!Number.isFinite(n)) return null;
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return n;
  return n / 100;
}

export function stripeCurrenciesMatch(reservaMoneda, stripeCurrency) {
  return normalizeStripeCurrency(reservaMoneda) === normalizeStripeCurrency(stripeCurrency);
}
