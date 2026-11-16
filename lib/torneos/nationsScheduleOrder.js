/** Reference-only Nations schedule ordering. Times are not a start gate. */
export const NATIONS_PHASES = Object.freeze(['GST','QF','SF','THIRD','FINAL']);
export const NATIONS_GST_COUNT = 30;
export const NATIONS_HAS_KO = true;

const fail = (code, message) => Object.assign(new Error(message), {code, status: 409});
const positiveInt = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

/** Validate persisted reference slots: 30 group slots + 8 KO slots, ordered per court. */
export function validateReferenceSlots(input, {requireKo = false} = {}) {
  if (!Array.isArray(input)) throw fail('SCHEDULE_SLOTS_REQUIRED', 'La programación orientativa requiere slots.');
  const seen = new Set();
  const byOrderCourt = new Map();
  let gst = 0, ko = 0; const gstIds = new Set();
  const rows = input.map((row, index) => {
    const key = String(row?.slot_key || '').trim();
    const phase = String(row?.phase || '').trim().toUpperCase();
    const court = String(row?.court_label ?? '').trim();
    const order = Number(row?.order);
    if (!key || seen.has(key)) throw fail('SCHEDULE_SLOT_DUPLICATE', 'Slot repetido o sin identidad.');
    seen.add(key);
    if (!NATIONS_PHASES.includes(phase)) throw fail('SCHEDULE_PHASE_INVALID', 'Fase inválida.');
    const keyValid = phase === 'GST' ? /^GST([1-9]|[12][0-9]|30)$/.test(key)
      : phase === 'QF' ? /^QF[1-4]$/.test(key)
      : phase === 'SF' ? /^SF[12]$/.test(key)
      : phase === 'THIRD' ? key === 'THIRD'
      : key === 'FINAL';
    if (!keyValid) throw fail('SCHEDULE_SLOT_KEY_INVALID', `Clave canónica inválida para ${phase}: ${key}`);
    if (!['1','2','3'].includes(court)) throw fail('SCHEDULE_COURT_INVALID', 'Cancha de referencia inválida.');
    if (!Number.isSafeInteger(order) || order < 1) throw fail('SCHEDULE_ORDER_INVALID', 'Orden de cancha inválido.');
    const list = byOrderCourt.get(court) || [];
    if (list.some(item => item.order === order)) throw fail('SCHEDULE_ORDER_DUPLICATE', 'Dos slots con el mismo orden en la cancha.');
    if (phase === 'GST') {
      gst += 1;
      if (!positiveInt(row?.partido_id)) throw fail('SCHEDULE_MATCH_REQUIRED', 'Un GST necesita partido real existente.');
      if (gstIds.has(String(row.partido_id))) throw fail('SCHEDULE_MATCH_DUPLICATE', 'Partido GST repetido.');
      gstIds.add(String(row.partido_id));
    } else {
      ko += 1;
      if (row?.partido_id != null && !positiveInt(row.partido_id)) throw fail('SCHEDULE_KO_FAKE_MATCH', 'Un KO no puede referenciar un partido inventado.');
    }
    const timestamp=String(row?.fecha_hora || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw fail('SCHEDULE_REFERENCE_TIME_INVALID', 'Hora de referencia inválida.');
    if (row?.duration_minutes != null && (!Number.isInteger(Number(row.duration_minutes)) || Number(row.duration_minutes) < 1)) throw fail('SCHEDULE_DURATION_INVALID', 'Duración opcional inválida.');
    list.push({order}); byOrderCourt.set(court, list);
    return {slot_key:key, phase, court_label:court, order, fecha_hora:String(row.fecha_hora), partido_id:row.partido_id ?? null, duration_minutes:row.duration_minutes ?? null, status:'prepared'};
  });
  for (const [court, list] of byOrderCourt) {
    list.sort((a,b)=>a.order-b.order);
    if (list.some((item,i)=> item.order !== i+1)) throw fail('SCHEDULE_ORDER_GAP', `La cancha ${court} debe tener orden secuencial desde 1.`);
  }
  if (gst !== NATIONS_GST_COUNT) throw fail('SCHEDULE_GST_COUNT', 'La programación requiere 30 GST.');
  if (requireKo && ko !== 8) throw fail('SCHEDULE_KO_COUNT', 'La programación requiere 8 slots KO.');
  return rows;
}

/** Next pending by explicit court order; delayed slots are never skipped or auto-started. */
export function nextPendingSlot(slots, {courtLabel, completedMatchIds = []} = {}) {
  const done = new Set((completedMatchIds || []).map(String));
  const court = String(courtLabel ?? '').trim();
  if (!court) return null;
  const candidates = (Array.isArray(slots) ? slots : [])
    .filter(row => String(row.court_label) === court)
    .filter(row => !row?.partido_id || !done.has(String(row.partido_id)))
    .sort((a,b)=>Number(a.order)-Number(b.order));
  return candidates[0] ?? null;
}

/** Only a real created bracket match can inherit a KO slot. No synthetic match IDs. */
export function inheritKoSlot(slot, createdMatch) {
  if (!slot || slot.phase === 'GST') throw fail('KO_SLOT_REQUIRED', 'Sólo un slot KO puede heredarse.');
  if (!createdMatch || !positiveInt(createdMatch.id) || createdMatch.phase === 'GST') throw fail('KO_MATCH_REQUIRED', 'Se requiere el partido KO real creado por clasificación.');
  return {slot_key:slot.slot_key, partido_id:Number(createdMatch.id), fecha_hora:slot.fecha_hora, court_label:slot.court_label, order:slot.order, duration_minutes:slot.duration_minutes ?? null};
}
