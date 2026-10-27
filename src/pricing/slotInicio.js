import { DateTime } from 'luxon';

// A bare ISO date/time is a venue-local wall time. Explicit offsets retain
// their instant. Ambiguous/nonexistent local times fail closed.
export function normalizeSlotInicio(raw, timezone) {
  if (raw == null || String(raw).trim() === '') return null;
  if (!DateTime.now().setZone(timezone).isValid) throw Object.assign(new Error('Zona horaria de la sede inválida'), { status: 400, code: 'TIMEZONE_INVALID' });
  const value = String(raw).trim();
  const localMatch = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
  let date;
  if (localMatch) {
    const canonical = `${localMatch[1]}T${localMatch[2]}:${localMatch[3] || '00'}`;
    date = DateTime.fromISO(canonical, { zone: timezone });
    if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== canonical || date.getPossibleOffsets().length !== 1) {
      throw Object.assign(new Error('La hora seleccionada no es única o no existe en la zona de la sede'), { status: 400, code: 'SLOT_LOCAL_INVALID' });
    }
  } else {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw Object.assign(new Error('slot_inicio inválido'), { status: 400 });
    date = DateTime.fromISO(value, { setZone: true });
    if (!date.isValid) throw Object.assign(new Error('slot_inicio inválido'), { status: 400 });
  }
  return date.toUTC().toISO();
}
