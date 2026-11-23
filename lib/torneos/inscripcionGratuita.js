const OPEN_STATES = new Set(['planificacion', 'abierto', 'inscripcion', 'inscripcion_abierta', 'proximo']);

function error(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function normalizarId(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Un precio sólo es válido si está explícitamente expresado como número
 * finito no negativo (o como string decimal). null/undefined/'' significan
 * "no configurado", no 0. Cualquier otra cosa es un dato inválido y se
 * rechaza: nunca se asume una inscripción gratuita por error de datos.
 */
function montoConfigurado(value, campo) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw error(`El ${campo} de inscripción es inválido.`, 422, 'ENROLLMENT_PRICE_INVALID');
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw error(`El ${campo} de inscripción es inválido.`, 422, 'ENROLLMENT_PRICE_INVALID');
  }
  const texto = value.trim();
  if (!texto) return null;
  if (!/^\d+(?:\.\d+)?$/.test(texto)) {
    throw error(`El ${campo} de inscripción es inválido.`, 422, 'ENROLLMENT_PRICE_INVALID');
  }
  const n = Number(texto);
  if (!Number.isFinite(n)) {
    throw error(`El ${campo} de inscripción es inválido.`, 422, 'ENROLLMENT_PRICE_INVALID');
  }
  return n;
}

/**
 * Precio efectivo de la inscripción.
 *
 * Precedencia: `inscripcion_monto` no nulo es autoritativo (incluido 0).
 * Si es null/undefined/'' se usa el legado `costo_inscripcion`. Si ninguno
 * está configurado el precio es ambiguo: se rechaza, no se asume gratis.
 */
function precio(torneo) {
  const moderno = montoConfigurado(torneo?.inscripcion_monto, 'inscripcion_monto');
  if (moderno != null) return moderno;
  const legado = montoConfigurado(torneo?.costo_inscripcion, 'costo_inscripcion');
  if (legado != null) return legado;
  throw error(
    'El torneo no tiene un precio de inscripción definido; no se confirma como gratuito por defecto.',
    409,
    'ENROLLMENT_PRICE_MISSING',
  );
}

function capacidad(torneo) {
  const n = Number(torneo?.cupos_maximos);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Decide si una inscripción puede confirmarse sin proveedor de pago.
 * No escribe DB: el caller transaccional carga torneo/equipo con lock y
 * persiste la decisión; este evaluador también se usa para pruebas focales.
 */
export function evaluarInscripcionGratuita({ torneo, equipo, actor, confirmedCount = 0, canonicalRelation = false, scopedManager = false }) {
  if (!torneo?.id || !equipo?.id) throw error('Torneo o equipo inválido.', 400, 'ENROLLMENT_INVALID');
  if (Number(equipo.torneo_id) !== Number(torneo.id)) throw error('El equipo no pertenece al torneo.', 409, 'TEAM_TOURNAMENT_MISMATCH');
  if (!actor?.id) throw error('Inicia sesión.', 401, 'AUTH_REQUIRED');
  if (canonicalRelation !== true && scopedManager !== true) {
    throw error('No existe una relación canónica verificable entre la cuenta y el equipo; la confirmación queda restringida.', 403, 'ENROLLMENT_AUTH_UNVERIFIED');
  }
  const monto = precio(torneo);
  if (monto > 0) throw error('La inscripción tiene costo; requiere pago verificado.', 409, 'PAYMENT_REQUIRED');
  if (!OPEN_STATES.has(String(torneo.estado || '').toLowerCase())) {
    throw error('El torneo no admite confirmaciones.', 409, 'ENROLLMENT_CLOSED');
  }
  const cap = capacidad(torneo);
  if (cap != null && Number(confirmedCount) >= cap && String(equipo.inscripcion_estado || '').toLowerCase() !== 'confirmado') {
    throw error('El torneo no tiene cupos disponibles.', 409, 'TOURNAMENT_FULL');
  }
  const already = String(equipo.inscripcion_estado || '').toLowerCase() === 'confirmado';
  return { ok: true, gratis: true, already };
}

function validarPool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw error('La confirmación atómica no está disponible.', 503, 'ENROLLMENT_ATOMIC_UNAVAILABLE');
  }
}

/**
 * Confirma una inscripción gratuita en una única transacción PostgreSQL.
 *
 * El lock `FOR UPDATE` sobre la fila del torneo serializa todas las
 * confirmaciones de ese torneo. Recién después, dentro de la misma
 * transacción, se cuenta y se actualiza el equipo: no queda la ventana
 * count -> update que permitía sobrecupo con equipos distintos.
 *
 * No aplica migraciones ni RPC: usa el `pgPool` existente. Si no hay pool,
 * falla cerrado (503) en vez de caer al patrón inseguro.
 */
export async function confirmarInscripcionGratuitaAtomica({ pool, torneoId, equipoId, actor }) {
  validarPool(pool);
  if (!Number.isSafeInteger(torneoId) || torneoId <= 0 || !Number.isSafeInteger(equipoId) || equipoId <= 0) {
    throw error('equipo_id y torneo_id son requeridos.', 400, 'ENROLLMENT_INVALID');
  }
  if (!actor?.id) throw error('Inicia sesión.', 401, 'AUTH_REQUIRED');

  let client;
  try {
    client = await pool.connect();
  } catch {
    throw error('La confirmación atómica no está disponible.', 503, 'ENROLLMENT_ATOMIC_UNAVAILABLE');
  }

  try {
    await client.query('BEGIN');

    const torneo = (
      await client.query(
        `SELECT id, sede_id, estado, inscripcion_monto, costo_inscripcion, cupos_maximos
           FROM public.torneos
          WHERE id = $1
          FOR UPDATE`,
        [torneoId],
      )
    ).rows[0];
    if (!torneo) throw error('Torneo no encontrado.', 404, 'TOURNAMENT_NOT_FOUND');

    const equipo = (
      await client.query(
        `SELECT id, torneo_id, creador_id, jugadores, inscripcion_estado
           FROM public.equipos
          WHERE id = $1 AND torneo_id = $2
          FOR UPDATE`,
        [equipoId, torneoId],
      )
    ).rows[0];
    if (!equipo) throw error('Equipo no encontrado en el torneo.', 404, 'TEAM_NOT_FOUND');

    // Relación canónica escrita por servidor: participante vinculado al actor dentro
    // del equipo. creador_id/jugadores[] del row no son pruebas de autorización
    // porque la web los escribe directamente con Supabase.
    const relacion = (
      await client.query(
        `SELECT 1
           FROM public.torneo_participante_equipos pe
           JOIN public.torneo_participantes p
             ON p.id = pe.participante_id AND p.torneo_id = pe.torneo_id
          WHERE pe.torneo_id = $1 AND pe.equipo_id = $2 AND p.linked_user_id = $3
          LIMIT 1`,
        [torneoId, equipoId, actor.id],
      )
    ).rows.length > 0;

    // Preserve the same persisted management scope used by canonical registration.
    // Never authorize from request metadata, creator_id, or the editable roster.
    let scopedManager = false;
    if (!relacion) {
      const roles = (await client.query(
        'SELECT role, sede_id FROM public.user_roles WHERE user_id = $1 FOR SHARE',
        [actor.id],
      )).rows;
      if (roles.length === 1) {
        const role = roles[0];
        const roleSede = Number(role.sede_id);
        const torneoSede = Number(torneo.sede_id);
        scopedManager = role.role === 'super_admin' || (
          role.role === 'admin_club' && Number.isSafeInteger(roleSede) && roleSede > 0 &&
          Number.isSafeInteger(torneoSede) && torneoSede > 0 && roleSede === torneoSede
        );
      }
    }

    const confirmados = (
      await client.query(
        `SELECT count(*)::int AS confirmados
           FROM public.equipos
          WHERE torneo_id = $1 AND inscripcion_estado = 'confirmado'`,
        [torneoId],
      )
    ).rows[0]?.confirmados ?? 0;

    const decision = evaluarInscripcionGratuita({
      torneo,
      equipo,
      actor,
      confirmedCount: confirmados,
      canonicalRelation: relacion,
      scopedManager,
    });

    if (decision.already) {
      await client.query('COMMIT');
      return {
        ...decision,
        equipo_id: equipoId,
        torneo_id: torneoId,
        inscripcion_estado: equipo.inscripcion_estado,
      };
    }

    const actualizado = (
      await client.query(
        `UPDATE public.equipos
            SET inscripcion_estado = 'confirmado'
          WHERE id = $1
            AND torneo_id = $2
            AND inscripcion_estado = 'pendiente'
        RETURNING id, inscripcion_estado`,
        [equipoId, torneoId],
      )
    ).rows[0];
    if (!actualizado) {
      throw error('La inscripción cambió mientras se confirmaba.', 409, 'ENROLLMENT_CONFLICT');
    }

    await client.query('COMMIT');
    return {
      ...decision,
      already: false,
      equipo_id: equipoId,
      torneo_id: torneoId,
      inscripcion_estado: actualizado.inscripcion_estado,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* el error original es el que importa */
    }
    throw err;
  } finally {
    client.release();
  }
}

export { precio as precioInscripcionTorneo };
