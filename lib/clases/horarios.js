/**
 * Resolución de horarios de clases.
 *
 * El DDL efectivo de `clases_horarios` es recurrente:
 *   (clase_id, dia_semana 0-6, hora_inicio time, hora_fin time)
 * (ver sql/tests/20261016_tournament_planning_bootstrap.sql y
 * sql/migrations/20261016100000_tournament_planning.sql).
 *
 * El router público (/api/clases/disponibles) necesita `fecha`/`hora` para
 * responder. La zona horaria sale de `sedes.timezone` (contrato existente),
 * NUNCA de una zona enviada por el cliente. Si la zona falta o es inválida NO
 * se asume Argentina en silencio: se levanta un error tipado para que el
 * router pida revisión y no publique una ocurrencia inventada.
 *
 * Este módulo distingue:
 *  - ausencia real de tablas de horarios -> null (no es un fallo técnico);
 *  - fallo técnico de detección o lectura -> ClasesHorariosError
 *    CLASES_HORARIOS_UNAVAILABLE (el router responde 503 con retry);
 *  - sede con timezone inválida/ausente -> ClasesHorariosError
 *    CLASES_SEDE_TIMEZONE_INVALIDA (revisión necesaria).
 * Tampoco fabrica fechas desde `created_at`.
 */

export const ZONA_FALLBACK = 'America/Argentina/Buenos_Aires';
/** Alias histórico: fallback explícito cuando un caller pide Argentina. */
export const ZONA_CLASES = ZONA_FALLBACK;

export const CODIGO_HORARIOS_UNAVAILABLE = 'CLASES_HORARIOS_UNAVAILABLE';
export const CODIGO_SEDE_TIMEZONE_INVALIDA = 'CLASES_SEDE_TIMEZONE_INVALIDA';

export const TABLAS_HORARIOS = ['clases_horarios', 'clases_disponibilidad'];

export const SONDEO_HORARIO_RECURRENTE = 'dia_semana, hora_inicio, hora_fin';
export const SONDEO_HORARIO_LEGACY = 'fecha, hora';

const FORMATOS_POR_ZONA = new Map();

/** Error de dominio con código estable para el router. */
export class ClasesHorariosError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ClasesHorariosError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** '9:05:00' | '09:05' | '09:05:00+00' -> '09:05'; inválido -> null */
export function normalizeHora(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const horas = Number(match[1]);
  const minutos = Number(match[2]);
  if (!Number.isInteger(horas) || horas > 23) return null;
  if (!Number.isInteger(minutos) || minutos > 59) return null;
  return `${pad2(horas)}:${pad2(minutos)}`;
}

/** '2026-11-22' | Date | timestamp ISO -> 'YYYY-MM-DD' válido o null */
export function normalizeFechaYmd(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Zona IANA válida de una sede, o null si falta/es inválida. Devuelve el
 * string tal como está persistido (ICU puede aliasear Argentina).
 * No depende de la zona del proceso ni de datos del cliente.
 */
export function zonaValida(zona) {
  if (typeof zona !== 'string') return null;
  const candidata = zona.trim();
  if (!candidata) return null;
  try {
    formatoDeZona(candidata);
    return candidata;
  } catch {
    return null;
  }
}

/** Motivo de revisión de una zona: null (ok), 'ausente' o 'invalida'. */
export function motivoZonaInvalida(zona) {
  if (zona == null || (typeof zona === 'string' && !zona.trim())) return 'ausente';
  return zonaValida(zona) ? null : 'invalida';
}

/**
 * Fallback explícito para callers históricos. El camino de horarios NO usa
 * esta función: usa zonaValida + error de revisión.
 */
export function normalizarZona(zona) {
  return zonaValida(zona) ?? ZONA_FALLBACK;
}

function formatoDeZona(zona) {
  let formato = FORMATOS_POR_ZONA.get(zona);
  if (!formato) {
    formato = new Intl.DateTimeFormat('en-US', {
      timeZone: zona,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    FORMATOS_POR_ZONA.set(zona, formato);
  }
  return formato;
}

/** Fecha/hora local de un instante en una zona IANA explícita. */
export function fechaHoraEnZona(now = new Date(), zona = ZONA_FALLBACK) {
  const valida = zonaValida(zona);
  if (!valida) {
    throw new ClasesHorariosError(
      CODIGO_SEDE_TIMEZONE_INVALIDA,
      'Zona horaria de sede inválida o ausente',
      { timezone: zona ?? null, motivo: motivoZonaInvalida(zona) },
    );
  }
  const partes = formatoDeZona(valida).formatToParts(new Date(now));
  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
  return {
    fecha: `${valor('year')}-${valor('month')}-${valor('day')}`,
    hora: `${valor('hour')}:${valor('minute')}`,
    zona: valida,
  };
}

/** YMD actual en la zona de la sede. */
export function hoyEnZona(now = new Date(), zona = ZONA_FALLBACK) {
  return fechaHoraEnZona(now, zona).fecha;
}

/** HH:MM actual en la zona de la sede. */
export function horaEnZona(now = new Date(), zona = ZONA_FALLBACK) {
  return fechaHoraEnZona(now, zona).hora;
}

/** Reloj Argentina explícito (fallback del contrato, no silencioso). */
export function hoyArgentinaYmd(now = new Date()) {
  return hoyEnZona(now, ZONA_FALLBACK);
}

/** Reloj Argentina explícito (fallback del contrato, no silencioso). */
export function horaArgentinaActual(now = new Date()) {
  return horaEnZona(now, ZONA_FALLBACK);
}

/** Día de semana 0=domingo..6=sábado para un YMD calendario. */
export function diaSemanaDesdeYmd(ymd) {
  const fecha = normalizeFechaYmd(ymd);
  if (!fecha) return null;
  const [anio, mes, dia] = fecha.split('-').map((x) => parseInt(x, 10));
  const utc = new Date(Date.UTC(anio, mes - 1, dia));
  if (Number.isNaN(utc.getTime())) return null;
  return utc.getUTCDay();
}

/** Suma días calendario a un YMD sin cruzar husos horarios. */
export function sumarDiasYmd(ymd, dias) {
  const fecha = normalizeFechaYmd(ymd);
  if (!fecha) return null;
  const [anio, mes, dia] = fecha.split('-').map((x) => parseInt(x, 10));
  const utc = new Date(Date.UTC(anio, mes - 1, dia + Number(dias || 0)));
  if (Number.isNaN(utc.getTime())) return null;
  return utc.toISOString().slice(0, 10);
}

/**
 * Próxima fecha (hoy o futuro) para un turno recurrente, en el calendario
 * local de la sede. Si el turno cae hoy pero su hora local ya pasó, devuelve
 * la semana siguiente. `horaActual` es 'HH:MM' en esa misma zona.
 */
export function proximaFechaRecurrente({ diaSemana, horaInicio, hoyYmd, horaActual = null } = {}) {
  const hoy = normalizeFechaYmd(hoyYmd);
  const dia = Number(diaSemana);
  if (!hoy || !Number.isInteger(dia) || dia < 0 || dia > 6) return null;
  const diaHoy = diaSemanaDesdeYmd(hoy);
  if (diaHoy == null) return null;
  let delta = (dia - diaHoy + 7) % 7;
  const hora = normalizeHora(horaInicio);
  if (delta === 0 && hora && horaActual && normalizeHora(horaActual)) {
    if (hora <= normalizeHora(horaActual)) delta = 7;
  }
  return sumarDiasYmd(hoy, delta);
}

/**
 * Normaliza una fila de horario, sea recurrente o legacy, a la forma que
 * consume el router. Devuelve null si no hay información utilizable:
 * nunca completa fecha/hora con `created_at` (eso sería falso éxito).
 */
export function normalizarHorario(row, { hoyYmd, horaActual = null, zona = null } = {}) {
  if (!row || typeof row !== 'object') return null;
  const zonaSalida = zonaValida(zona);

  const horaInicio = normalizeHora(row.hora_inicio);
  const esRecurrente = row.dia_semana != null && (horaInicio != null || normalizeHora(row.hora) != null);

  if (esRecurrente) {
    const dia = Number(row.dia_semana);
    const hora = horaInicio ?? normalizeHora(row.hora);
    const fecha = proximaFechaRecurrente({ diaSemana: dia, horaInicio: hora, hoyYmd, horaActual });
    if (fecha == null) return null;
    return {
      horario_id: row.id ?? null,
      fecha,
      hora,
      dia_semana: dia,
      hora_inicio: hora,
      hora_fin: normalizeHora(row.hora_fin),
      recurrente: true,
      zona_horaria: zonaSalida,
    };
  }

  // Forma legacy: sólo la fila con fecha y hora reales; sin inventar desde
  // created_at. Si falta cualquiera de las dos, no hay ocurrencia.
  const fecha = normalizeFechaYmd(row.fecha);
  const hora = normalizeHora(row.hora);
  if (!fecha || !hora) return null;
  return {
    horario_id: row.id ?? null,
    fecha,
    hora,
    dia_semana: null,
    hora_inicio: null,
    hora_fin: null,
    recurrente: false,
    zona_horaria: zonaSalida,
  };
}

function errorTecnicoHorarios(message, extra = {}) {
  return new ClasesHorariosError(CODIGO_HORARIOS_UNAVAILABLE, message, extra);
}

function esErrorAusenciaTabla(error) {
  const code = String(error?.code ?? '');
  const mensaje = String(error?.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /could not find the table|relation .* does not exist/.test(mensaje)
  );
}

function esErrorColumna(error) {
  const code = String(error?.code ?? '');
  const mensaje = String(error?.message ?? '').toLowerCase();
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    /column .* does not exist/.test(mensaje) ||
    /could not find the '.*' column/.test(mensaje)
  );
}

async function probarColumnas(supabaseAdmin, tabla, columnas) {
  try {
    return await supabaseAdmin.from(tabla).select(columnas).limit(1);
  } catch (error) {
    return { data: null, error: { code: error?.code, message: error?.message } };
  }
}

/**
 * Detecta qué tabla/forma usar, probando las columnas reales contra PostgREST.
 * - Ausencia real de las tablas -> null.
 * - Tabla existente pero sin forma conocida -> error técnico.
 * - Error de red/5xx/timeout -> error técnico (el router responde 503 y
 *   resetea el cache para reintentar).
 */
export async function detectarEsquemaHorarios(supabaseAdmin) {
  for (const tabla of TABLAS_HORARIOS) {
    const recurrente = await probarColumnas(supabaseAdmin, tabla, SONDEO_HORARIO_RECURRENTE);
    if (!recurrente?.error) return { tabla, forma: 'recurrente' };
    if (esErrorAusenciaTabla(recurrente.error)) continue;
    if (!esErrorColumna(recurrente.error)) {
      throw errorTecnicoHorarios(`No se pudo detectar el esquema de ${tabla}`, {
        tabla,
        causa: recurrente.error.message,
      });
    }

    const legacy = await probarColumnas(supabaseAdmin, tabla, SONDEO_HORARIO_LEGACY);
    if (!legacy?.error) return { tabla, forma: 'legacy' };
    if (esErrorAusenciaTabla(legacy.error)) continue;
    // La tabla existe pero no tiene ni la forma recurrente ni la legacy:
    // no es vacío válido, es un fallo de detección.
    throw errorTecnicoHorarios(`El esquema de ${tabla} no es reconocible`, {
      tabla,
      causa: legacy.error.message,
    });
  }
  return null;
}

/**
 * Carga y agrupa horarios por clase para el esquema detectado.
 * Recurrente: sin filtro por `fecha` (no existe en el DDL); la ocurrencia se
 * calcula con el reloj local de la sede de cada clase.
 * Legacy: mantiene el filtro `fecha >= hoy` y sólo acepta filas completas.
 *
 * `zonaPorClaseId` mapea clase_id -> sedes.timezone (obligatorio y válido).
 * Un error de lectura NO se convierte en {}: se levanta
 * CLASES_HORARIOS_UNAVAILABLE para que el router responda 503 con retry.
 */
export async function cargarHorariosPorClase(
  supabaseAdmin,
  esquema,
  claseIds,
  { ahora = new Date(), zonaPorClaseId = {} } = {},
) {
  const ids = (claseIds || []).filter((id) => id != null);
  if (!esquema || ids.length === 0) return {};

  const relojesPorZona = new Map();
  function relojDeClase(claseId) {
    const cruda = zonaPorClaseId[String(claseId)] ?? null;
    const zona = zonaValida(cruda);
    if (!zona) {
      throw new ClasesHorariosError(
        CODIGO_SEDE_TIMEZONE_INVALIDA,
        'La sede de la clase no tiene una zona horaria válida',
        { clase_id: Number(claseId), timezone: cruda, motivo: motivoZonaInvalida(cruda) },
      );
    }
    if (!relojesPorZona.has(zona)) {
      relojesPorZona.set(zona, fechaHoraEnZona(ahora, zona));
    }
    return relojesPorZona.get(zona);
  }

  let query = supabaseAdmin
    .from(esquema.tabla)
    .select('*')
    .in('clase_id', ids);

  if (esquema.forma === 'legacy') {
    // Un solo query para varias sedes: se usa la fecha local más temprana
    // como cota inferior y luego se filtra por la fecha local de cada clase.
    const fechas = ids.map((id) => relojDeClase(id).fecha).filter(Boolean);
    const minYmd = fechas.sort()[0];
    query = query.gte('fecha', minYmd);
  }

  query = esquema.forma === 'legacy'
    ? query.order('fecha', { ascending: true }).order('hora', { ascending: true })
    : query.order('dia_semana', { ascending: true }).order('hora_inicio', { ascending: true });

  let resultado;
  try {
    resultado = await query;
  } catch (error) {
    throw errorTecnicoHorarios(`No se pudieron leer los horarios de ${esquema.tabla}`, {
      tabla: esquema.tabla,
      causa: error?.message,
    });
  }
  const { data, error } = resultado || {};
  if (error) {
    throw errorTecnicoHorarios(`No se pudieron leer los horarios de ${esquema.tabla}`, {
      tabla: esquema.tabla,
      causa: error.message,
    });
  }

  const agrupados = {};
  for (const row of data || []) {
    const reloj = relojDeClase(row.clase_id);
    const normalizado = normalizarHorario(row, {
      hoyYmd: reloj.fecha,
      horaActual: reloj.hora,
      zona: reloj.zona,
    });
    if (!normalizado) continue;
    // Legacy: la fila debe seguir vigente en el calendario local de SU sede.
    if (esquema.forma === 'legacy' && normalizado.fecha < reloj.fecha) continue;
    const key = String(row.clase_id);
    (agrupados[key] ??= []).push(normalizado);
  }
  return agrupados;
}
