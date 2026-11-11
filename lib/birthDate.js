/** Validacion estricta de fecha de nacimiento (calendario real, edad 5-120, no futura). */
const MIN_AGE = 5, MAX_AGE = 120;
export function parseBirthDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  return {y, m: mo, d};
}
export function ageOnDate({y, m, d}, now = new Date()) {
  let age = now.getUTCFullYear() - y;
  const before = now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (before) age -= 1;
  return age;
}
export function validateBirthDate(value, now = new Date()) {
  const parsed = parseBirthDate(value);
  if (!parsed) return {ok:false, code:'INVALID_DATE'};
  const age = ageOnDate(parsed, now);
  if (age < 0) return {ok:false, code:'FUTURE_DATE'};
  if (age < MIN_AGE || age > MAX_AGE) return {ok:false, code:'AGE_OUT_OF_RANGE'};
  return {ok:true, iso:`${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`, age};
}
