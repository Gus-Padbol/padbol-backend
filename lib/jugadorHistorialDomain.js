/** Historial unificado del jugador — dominio puro (FASE 1). */

export const JUGADOR_HISTORIAL_TIPOS = Object.freeze([
  'reserva',
  'partido',
  'padcoins',
  'membresia',
  'logro',
]);

export const JUGADOR_HISTORIAL_LIMIT_DEFAULT = 20;
export const JUGADOR_HISTORIAL_LIMIT_MAX = 50;
/** Límite por fuente antes del merge (evita cargar historiales completos). */
export const JUGADOR_HISTORIAL_SOURCE_LIMIT = 100;

export function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

export function parseHistorialLimit(raw) {
  if (raw == null || raw === '') return JUGADOR_HISTORIAL_LIMIT_DEFAULT;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw httpError(400, 'limit inválido', 'LIMIT_INVALID');
  }
  return Math.min(n, JUGADOR_HISTORIAL_LIMIT_MAX);
}

export function parseHistorialSedeId(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw httpError(400, 'sede_id inválido', 'SEDE_ID_INVALID');
  }
  return n;
}

export function parseHistorialTipos(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const parts = String(raw)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const valid = [...new Set(parts.filter((t) => JUGADOR_HISTORIAL_TIPOS.includes(t)))];
  const invalid = parts.filter((t) => !JUGADOR_HISTORIAL_TIPOS.includes(t));
  if (parts.length > 0 && valid.length === 0) {
    throw httpError(400, `tipos inválidos: ${invalid.join(', ')}`, 'TIPOS_INVALID');
  }
  return valid;
}

export function parseHistorialIsoDate(raw, fieldName) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw httpError(400, `${fieldName} inválida`, 'FECHA_INVALID');
  }
  return d.toISOString();
}

/**
 * Cursor estable: occurred_at|id (URL-encoded id).
 */
export function encodeHistorialCursor(event) {
  if (!event?.occurred_at || !event?.id) return null;
  return `${event.occurred_at}|${encodeURIComponent(String(event.id))}`;
}

export function decodeHistorialCursor(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const pipe = s.indexOf('|');
  if (pipe <= 0 || pipe === s.length - 1) {
    throw httpError(400, 'cursor inválido', 'CURSOR_INVALID');
  }
  const occurredAt = s.slice(0, pipe);
  const id = decodeURIComponent(s.slice(pipe + 1));
  if (!occurredAt || !id || Number.isNaN(new Date(occurredAt).getTime())) {
    throw httpError(400, 'cursor inválido', 'CURSOR_INVALID');
  }
  return { occurred_at: new Date(occurredAt).toISOString(), id: String(id) };
}

export function compareHistorialEventsDesc(a, b) {
  const ta = String(a.occurred_at || '');
  const tb = String(b.occurred_at || '');
  if (ta !== tb) return tb.localeCompare(ta);
  return String(b.id || '').localeCompare(String(a.id || ''));
}

/** true si `event` es estrictamente anterior al cursor en orden DESC (occurred_at, id). */
export function isHistorialEventAfterCursor(event, cursor) {
  if (!cursor) return true;
  const ta = String(event.occurred_at || '');
  const tc = String(cursor.occurred_at || '');
  if (ta !== tc) return ta < tc;
  return String(event.id || '') < String(cursor.id || '');
}

export function isValidOccurredAt(raw) {
  if (raw == null || raw === '') return false;
  const t = new Date(raw).getTime();
  return Number.isFinite(t);
}

export function toIsoOrNull(raw) {
  if (!isValidOccurredAt(raw)) return null;
  return new Date(raw).toISOString();
}

/** Combina fecha (YYYY-MM-DD) + hora (HH:MM[:SS]) en ISO; null si inválido. */
export function combineFechaHora(fecha, hora) {
  const f = String(fecha || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  let h = String(hora || '').trim();
  if (!h) h = '00:00:00';
  if (/^\d{2}:\d{2}$/.test(h)) h = `${h}:00`;
  if (!/^\d{2}:\d{2}:\d{2}/.test(h)) return null;
  // Interpretar como UTC local-agnostic estable (fecha programada).
  const iso = `${f}T${h.slice(0, 8)}.000Z`;
  return toIsoOrNull(iso);
}

export function buildHistorialEvent({
  tipo,
  refId,
  occurred_at,
  sede_id = null,
  titulo,
  resumen,
  payload = {},
}) {
  if (!JUGADOR_HISTORIAL_TIPOS.includes(tipo)) return null;
  const at = toIsoOrNull(occurred_at);
  if (!at) return null;
  const idPart = String(refId ?? '').trim();
  if (!idPart) return null;
  const sede =
    sede_id == null || sede_id === ''
      ? null
      : (Number.isFinite(Number(sede_id)) ? Number(sede_id) : null);

  return {
    id: `${tipo}:${idPart}`,
    tipo,
    occurred_at: at,
    sede_id: sede,
    titulo: String(titulo || tipo).trim() || tipo,
    resumen: String(resumen || '').trim() || titulo || tipo,
    visibilidad: 'privada',
    referencia: {
      tipo,
      id: idPart,
    },
    payload: payload && typeof payload === 'object' ? payload : {},
  };
}

export function filterHistorialEvents(events, {
  tipos = null,
  fecha_desde = null,
  fecha_hasta = null,
  sede_id = null,
  cursor = null,
} = {}) {
  let out = Array.isArray(events) ? [...events] : [];

  if (tipos && tipos.length) {
    const set = new Set(tipos);
    out = out.filter((e) => set.has(e.tipo));
  }
  if (fecha_desde) {
    out = out.filter((e) => String(e.occurred_at) >= fecha_desde);
  }
  if (fecha_hasta) {
    out = out.filter((e) => String(e.occurred_at) <= fecha_hasta);
  }
  if (sede_id != null) {
    out = out.filter((e) => e.sede_id != null && Number(e.sede_id) === Number(sede_id));
  }
  if (cursor) {
    out = out.filter((e) => isHistorialEventAfterCursor(e, cursor));
  }

  out.sort(compareHistorialEventsDesc);
  return out;
}

export function paginateHistorialEvents(events, limit) {
  const lim = Math.min(
    Math.max(1, Number(limit) || JUGADOR_HISTORIAL_LIMIT_DEFAULT),
    JUGADOR_HISTORIAL_LIMIT_MAX,
  );
  const has_more = events.length > lim;
  const items = events.slice(0, lim);
  const last = items[items.length - 1] || null;
  return {
    items,
    pagination: {
      limit: lim,
      next_cursor: has_more && last ? encodeHistorialCursor(last) : null,
      has_more,
    },
  };
}

export function normalizeReservaEvent(row) {
  if (!row?.id) return null;
  const scheduled = combineFechaHora(row.fecha, row.hora_inicio || row.hora);
  const occurred_at = scheduled || toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const estado = String(row.estado || '').trim() || null;
  return buildHistorialEvent({
    tipo: 'reserva',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'Reserva',
    resumen: estado ? `Reserva ${estado}` : 'Reserva',
    payload: {
      fecha: row.fecha ?? null,
      hora: row.hora ?? row.hora_inicio ?? null,
      cancha: row.cancha ?? null,
      estado,
      sede_nombre: row.sede ?? row.sede_nombre ?? null,
    },
  });
}

export function normalizePartidoEvent(row) {
  if (!row?.id) return null;
  const scheduled = combineFechaHora(row.fecha, row.hora);
  const occurred_at = scheduled || toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const estado = String(row.estado || '').trim() || null;
  return buildHistorialEvent({
    tipo: 'partido',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'Partido',
    resumen: estado ? `Partido ${estado}` : 'Partido',
    payload: {
      fecha: row.fecha ?? null,
      hora: row.hora ?? null,
      estado,
      deporte: row.deporte ?? null,
      sede_nombre: row.sede_nombre ?? row.sedes?.nombre ?? null,
      nivel: row.nivel ?? null,
    },
  });
}

export function normalizePadcoinsEvent(row) {
  if (!row?.id) return null;
  const occurred_at = toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const monto = row.monto != null ? Number(row.monto) : null;
  const tipoMov = String(row.tipo || '').trim() || null;
  const sign = monto != null && monto >= 0 ? '+' : '';
  const resumen = tipoMov
    ? (monto != null && Number.isFinite(monto) ? `${tipoMov} (${sign}${monto})` : tipoMov)
    : 'Movimiento PadCoins';
  return buildHistorialEvent({
    tipo: 'padcoins',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'PadCoins',
    resumen,
    payload: {
      tipo: tipoMov,
      monto: Number.isFinite(monto) ? monto : null,
      referencia_tipo: row.referencia_tipo ?? null,
      referencia_id: row.referencia_id != null ? String(row.referencia_id) : null,
      saldo_despues: row.saldo_despues != null ? Number(row.saldo_despues) : null,
    },
  });
}

export function normalizeMembresiaEvent(row) {
  if (!row?.id) return null;
  // Un evento por fila: preferir inicio (alta), luego created_at, luego vencimiento.
  const occurred_at =
    toIsoOrNull(row.inicio)
    || toIsoOrNull(row.created_at)
    || toIsoOrNull(row.vencimiento);
  if (!occurred_at) return null;
  const estado = String(row.estado || '').trim() || null;
  return buildHistorialEvent({
    tipo: 'membresia',
    refId: row.id,
    occurred_at,
    sede_id: row.sede_id ?? null,
    titulo: 'Membresía',
    resumen: estado ? `Membresía ${estado}` : 'Membresía',
    payload: {
      estado,
      plan_id: row.plan_id ?? null,
      inicio: row.inicio ?? null,
      vencimiento: row.vencimiento ?? null,
      origen: row.origen ?? null,
    },
  });
}

export function normalizeLogroEvent(row) {
  const slug = row?.slug || row?.logros?.codigo || null;
  const refId = row?.id != null ? row.id : (slug || null);
  if (refId == null || refId === '') return null;
  const occurred_at =
    toIsoOrNull(row.desbloqueado_en)
    || toIsoOrNull(row.contexto?.desbloqueado_en)
    || toIsoOrNull(row.created_at);
  if (!occurred_at) return null;
  const label = slug ? String(slug) : String(refId);
  return buildHistorialEvent({
    tipo: 'logro',
    refId,
    occurred_at,
    sede_id: null,
    titulo: 'Logro',
    resumen: `Logro desbloqueado: ${label}`,
    payload: {
      slug: slug ? String(slug) : null,
      logro_id: row.logro_id ?? null,
    },
  });
}

export function assertNoPrivateLeak(event) {
  const forbidden = [
    'email', 'telefono', 'whatsapp', 'documento', 'dni', 'password',
    'token', 'qr_token', 'access_token', 'refresh_token', 'role', 'rol',
    'mp_payment_id', 'mp_preference_id', 'notas', 'created_by',
  ];
  const blob = JSON.stringify(event);
  return !forbidden.some((k) => {
    const re = new RegExp(`"${k}"\\s*:`, 'i');
    return re.test(blob);
  });
}
