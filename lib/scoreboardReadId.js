// UUID input syntax accepted by PostgreSQL, without restricting UUID version.
// Keep existing uppercase, compact, braced and four-digit-group forms compatible.
export function isScoreboardReadId(value) {
  if (typeof value !== 'string') return false;
  const raw = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  return /^(?:[0-9a-f]{4}-?){7}[0-9a-f]{4}$/i.test(raw);
}
