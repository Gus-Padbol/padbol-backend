import {
  PADBOL_MATCH_GLOBAL_PADCOINS_PER_UNIT,
  PADBOL_MATCH_RECOMMENDED_LOYALTY_PERCENT,
  PADBOL_MATCH_SETUP_CHECKLIST_LABELS,
  PADBOL_MATCH_SETUP_NEXT_ACTIONS,
  PADBOL_MATCH_SETUP_STEP_KEYS,
  PADBOL_MATCH_SETUP_STEPS,
  PADBOL_MATCH_SUGGESTED_PREMIOS,
} from './padbolMatchSetupConfig.js';
import {
  normalizePadcoinsSedeRuleOverrides,
  resolvePadcoinsConfigForSede,
  updatePadcoinsSedeRuleOverrides,
} from '../padcoins/padcoinsEffectiveConfigService.js';
import {
  getPadcoinsSedeConfig,
  upsertPadcoinsSedeConfig,
} from '../padcoins/padcoinsSedeConfigService.js';
import { PADCOINS_GLOBAL_CONFIG_DEFAULTS } from '../padcoins/padcoinsGlobalConfigService.js';
import {
  createPremioCanjeable,
  listPremiosCanjeables,
} from '../padcoins/premiosCanjeablesService.js';

const SETUP_STATUS_SELECT = [
  'id',
  'sede_id',
  'admin_sede_configurado',
  'padcoins_activado',
  'padcoins_default_5_configurado',
  'beneficios_iniciales_configurados',
  'campanas_habilitadas',
  'reserva_visible_para_jugador',
  'checklist_completo',
  'last_checked_at',
  'notes',
  'created_at',
  'updated_at',
].join(', ');

const BOOLEAN_STEP_COLUMNS = new Set(
  PADBOL_MATCH_SETUP_STEP_KEYS.filter((key) => key !== PADBOL_MATCH_SETUP_STEPS.CHECKLIST_COMPLETO),
);

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function defaultSetupStatusRow(sedeId) {
  return {
    id: null,
    sede_id: sedeId,
    admin_sede_configurado: false,
    padcoins_activado: false,
    padcoins_default_5_configurado: false,
    beneficios_iniciales_configurados: false,
    campanas_habilitadas: false,
    reserva_visible_para_jugador: false,
    checklist_completo: false,
    last_checked_at: null,
    notes: null,
    created_at: null,
    updated_at: null,
  };
}

function normalizeSetupStatusRow(row, sedeId) {
  if (!row) return defaultSetupStatusRow(sedeId);

  return {
    id: row.id ?? null,
    sede_id: Number(row.sede_id ?? sedeId),
    admin_sede_configurado: row.admin_sede_configurado === true,
    padcoins_activado: row.padcoins_activado === true,
    padcoins_default_5_configurado: row.padcoins_default_5_configurado === true,
    beneficios_iniciales_configurados: row.beneficios_iniciales_configurados === true,
    campanas_habilitadas: row.campanas_habilitadas === true,
    reserva_visible_para_jugador: row.reserva_visible_para_jugador === true,
    checklist_completo: row.checklist_completo === true,
    last_checked_at: row.last_checked_at ?? null,
    notes: row.notes ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export function canReadPadbolMatchSetup(role, sedeId) {
  if (!role) return false;
  if (role.rol === 'super_admin') return true;
  if (role.rol === 'admin_club') {
    if (role.sede_id == null) return false;
    return Number(role.sede_id) === Number(sedeId);
  }
  return false;
}

export function canWritePadbolMatchSetup(role, sedeId) {
  if (!role || role.rol !== 'super_admin') return false;
  return parseSedeId(sedeId) != null;
}

async function assertSedeExists(supabaseAdmin, sedeId) {
  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre')
    .eq('id', sedeId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) {
    throw buildHttpError('Sede no encontrada', 404);
  }

  return data;
}

async function fetchSetupStatusRow(supabaseAdmin, sedeId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('padbol_match_setup_status')
      .select(SETUP_STATUS_SELECT)
      .eq('sede_id', sedeId)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) return null;
      throw error;
    }

    return data ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

async function upsertSetupStatusRow(supabaseAdmin, payload) {
  const sid = parseSedeId(payload.sede_id);
  if (!sid) throw buildHttpError('sede_id inválido');

  const row = {
    sede_id: sid,
    admin_sede_configurado: payload.admin_sede_configurado === true,
    padcoins_activado: payload.padcoins_activado === true,
    padcoins_default_5_configurado: payload.padcoins_default_5_configurado === true,
    beneficios_iniciales_configurados: payload.beneficios_iniciales_configurados === true,
    campanas_habilitadas: payload.campanas_habilitadas === true,
    reserva_visible_para_jugador: payload.reserva_visible_para_jugador === true,
    checklist_completo: payload.checklist_completo === true,
    last_checked_at: payload.last_checked_at ?? new Date().toISOString(),
    notes: payload.notes != null ? String(payload.notes).trim() || null : undefined,
    updated_at: new Date().toISOString(),
  };

  if (row.notes === undefined) {
    delete row.notes;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('padbol_match_setup_status')
      .upsert(row, { onConflict: 'sede_id' })
      .select(SETUP_STATUS_SELECT)
      .single();

    if (error) {
      if (isMissingTable(error)) {
        throw buildHttpError(
          'Tabla padbol_match_setup_status no existe. Ejecutá la migración SQL primero.',
          503,
        );
      }
      throw error;
    }

    return normalizeSetupStatusRow(data, sid);
  } catch (err) {
    if (isMissingTable(err)) {
      throw buildHttpError(
        'Tabla padbol_match_setup_status no existe. Ejecutá la migración SQL primero.',
        503,
      );
    }
    throw err;
  }
}

async function hasAdminClubForSede(supabaseAdmin, sedeId) {
  try {
    const { count, error } = await supabaseAdmin
      .from('user_roles')
      .select('email', { count: 'exact', head: true })
      .eq('role', 'admin_club')
      .eq('sede_id', sedeId);

    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

async function countCanchasForSede(supabaseAdmin, sedeId) {
  try {
    const { count, error } = await supabaseAdmin
      .from('canchas')
      .select('id', { count: 'exact', head: true })
      .eq('sede_id', sedeId);

    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function countPremiosForSede(supabaseAdmin, sedeId) {
  const premios = await listPremiosCanjeables(supabaseAdmin, { sede_id: sedeId });
  return premios.length;
}

function isRecommendedLoyaltyPercent(effectivePercent) {
  return Number(effectivePercent) === PADBOL_MATCH_RECOMMENDED_LOYALTY_PERCENT;
}

function buildChecklistItem(key, ok, detail) {
  return {
    key,
    label: PADBOL_MATCH_SETUP_CHECKLIST_LABELS[key] ?? key,
    status: ok ? 'ok' : 'missing',
    detail,
  };
}

async function computeDerivedSetupFlags(supabaseAdmin, sedeId, { now = new Date() } = {}) {
  const [
    sedeRow,
    padcoinsConfig,
    resolvedConfig,
    adminAssigned,
    canchasCount,
    premiosCount,
  ] = await Promise.all([
    assertSedeExists(supabaseAdmin, sedeId).catch(() => null),
    getPadcoinsSedeConfig(supabaseAdmin, sedeId, { now }),
    resolvePadcoinsConfigForSede(supabaseAdmin, sedeId, { now }).catch(() => null),
    hasAdminClubForSede(supabaseAdmin, sedeId),
    countCanchasForSede(supabaseAdmin, sedeId),
    countPremiosForSede(supabaseAdmin, sedeId),
  ]);

  const effectivePercent = resolvedConfig?.effective?.porcentaje_devolucion_reserva
    ?? PADCOINS_GLOBAL_CONFIG_DEFAULTS.porcentaje_devolucion_reserva;

  const globalConversion = resolvedConfig?.global?.padcoins_por_usd_equivalente
    ?? PADCOINS_GLOBAL_CONFIG_DEFAULTS.padcoins_por_usd_equivalente;

  const sedeOverrides = normalizePadcoinsSedeRuleOverrides(padcoinsConfig.rule_overrides);
  const hasCustomConversionOverride = Object.prototype.hasOwnProperty.call(
    sedeOverrides,
    'padcoins_por_usd_equivalente',
  );

  const padcoinsActivado = padcoinsConfig.participa === true;
  const padcoinsDefault5 = isRecommendedLoyaltyPercent(effectivePercent);
  const beneficiosOk = premiosCount > 0;
  const reservaVisible = Boolean(sedeRow?.nombre) && canchasCount > 0;
  const campanasHabilitadas = padcoinsActivado;

  return {
    admin_sede_configurado: adminAssigned,
    padcoins_activado: padcoinsActivado,
    padcoins_default_5_configurado: padcoinsDefault5,
    beneficios_iniciales_configurados: beneficiosOk,
    campanas_habilitadas: campanasHabilitadas,
    reserva_visible_para_jugador: reservaVisible,
    meta: {
      sede_nombre: sedeRow?.nombre ?? null,
      premios_count: premiosCount,
      canchas_count: canchasCount,
      effective_porcentaje_devolucion_reserva: effectivePercent,
      global_padcoins_por_unidad_interna: globalConversion,
      sede_override_conversion: hasCustomConversionOverride,
      padcoins_config_id: padcoinsConfig.id,
    },
  };
}

function buildValidationFromFlags(sedeId, flags) {
  const checklistKeys = [
    PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO,
    PADBOL_MATCH_SETUP_STEPS.PADCOINS_ACTIVADO,
    PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO,
    PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS,
    PADBOL_MATCH_SETUP_STEPS.CAMPANAS_HABILITADAS,
    PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR,
  ];

  const checklist = checklistKeys.map((key) => {
    const ok = flags[key] === true;
    let detail = ok ? 'Completo' : 'Pendiente';

    if (key === PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO) {
      detail = ok
        ? `Fidelización al ${PADBOL_MATCH_RECOMMENDED_LOYALTY_PERCENT}% (recomendado)`
        : `Porcentaje efectivo: ${flags.meta?.effective_porcentaje_devolucion_reserva ?? '—'}%`;
    }

    if (key === PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS) {
      detail = ok
        ? `${flags.meta?.premios_count ?? 0} beneficio(s) cargado(s)`
        : 'Sin beneficios canjeables en la sede';
    }

    if (key === PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR) {
      detail = ok
        ? `${flags.meta?.canchas_count ?? 0} cancha(s) disponible(s)`
        : 'Falta perfil de sede o canchas para reservar';
    }

    if (key === PADBOL_MATCH_SETUP_STEPS.CAMPANAS_HABILITADAS) {
      detail = ok
        ? 'PadCoins activo — la sede puede operar campañas'
        : 'Activar PadCoins antes de campañas';
    }

    return buildChecklistItem(key, ok, detail);
  });

  const missing = checklist
    .filter((item) => item.status !== 'ok')
    .map((item) => item.key);

  const next_actions = missing.map((key) => PADBOL_MATCH_SETUP_NEXT_ACTIONS[key]).filter(Boolean);

  const checklistCompleto = missing.length === 0;

  return {
    ok: checklistCompleto,
    sede_id: sedeId,
    checklist,
    missing,
    next_actions,
    checklist_completo: checklistCompleto,
    flags,
  };
}

export async function getSetupStatus(supabaseAdmin, sedeId, options = {}) {
  const sid = parseSedeId(sedeId);
  if (!sid) throw buildHttpError('sede_id inválido');

  await assertSedeExists(supabaseAdmin, sid);

  const [stored, derived] = await Promise.all([
    fetchSetupStatusRow(supabaseAdmin, sid),
    computeDerivedSetupFlags(supabaseAdmin, sid, options),
  ]);

  const mergedFlags = {
    admin_sede_configurado: derived.admin_sede_configurado,
    padcoins_activado: derived.padcoins_activado,
    padcoins_default_5_configurado: derived.padcoins_default_5_configurado,
    beneficios_iniciales_configurados: derived.beneficios_iniciales_configurados,
    campanas_habilitadas: derived.campanas_habilitadas,
    reserva_visible_para_jugador: derived.reserva_visible_para_jugador,
    checklist_completo: derived.admin_sede_configurado
      && derived.padcoins_activado
      && derived.padcoins_default_5_configurado
      && derived.beneficios_iniciales_configurados
      && derived.campanas_habilitadas
      && derived.reserva_visible_para_jugador,
  };

  return {
    sede_id: sid,
    status: normalizeSetupStatusRow(stored, sid),
    live: mergedFlags,
    meta: derived.meta,
    checklist_completo: mergedFlags.checklist_completo,
  };
}

export async function validateSetupForSede(supabaseAdmin, sedeId, options = {}) {
  const sid = parseSedeId(sedeId);
  if (!sid) throw buildHttpError('sede_id inválido');

  await assertSedeExists(supabaseAdmin, sid);

  const derived = await computeDerivedSetupFlags(supabaseAdmin, sid, options);
  const validation = buildValidationFromFlags(sid, derived);

  const persisted = await upsertSetupStatusRow(supabaseAdmin, {
    sede_id: sid,
    ...validation.flags,
    checklist_completo: validation.checklist_completo,
    last_checked_at: new Date().toISOString(),
  });

  return {
    ...validation,
    persisted,
  };
}

async function seedSuggestedPremios(supabaseAdmin, sedeId, { actor_user_id } = {}) {
  const existing = await listPremiosCanjeables(supabaseAdmin, { sede_id: sedeId });
  const existingNames = new Set(existing.map((p) => String(p.nombre).trim().toLowerCase()));

  const created = [];
  const skipped = [];

  for (const template of PADBOL_MATCH_SUGGESTED_PREMIOS) {
    const nombreKey = template.nombre.trim().toLowerCase();
    if (existingNames.has(nombreKey)) {
      skipped.push({ nombre: template.nombre, reason: 'already_exists' });
      continue;
    }

    const premio = await createPremioCanjeable(supabaseAdmin, {
      sede_id: sedeId,
      nombre: template.nombre,
      descripcion: template.descripcion,
      costo_padcoins: template.costo_padcoins,
      stock_total: template.stock_total,
      stock_disponible: template.stock_total,
      activo: true,
    });

    created.push({ id: premio.id, nombre: premio.nombre });
    existingNames.add(nombreKey);
  }

  return { created, skipped, actor_user_id: actor_user_id ?? null };
}

export async function initializePadCoinsSetupForSede(supabaseAdmin, sedeId, {
  actor_user_id = null,
  seed_beneficios = false,
  descripcion = null,
  now = new Date(),
} = {}) {
  const sid = parseSedeId(sedeId);
  if (!sid) throw buildHttpError('sede_id inválido');

  const sede = await assertSedeExists(supabaseAdmin, sid);

  const summary = {
    sede_id: sid,
    sede_nombre: sede.nombre,
    created: [],
    already_existed: [],
    updated: [],
    skipped: [],
    missing: [],
    global_conversion: {
      padcoins_por_unidad_interna: PADBOL_MATCH_GLOBAL_PADCOINS_PER_UNIT,
      source: 'global',
      note: 'Conversión mundial fija — la sede no la modifica.',
    },
    recommended_loyalty_percent: PADBOL_MATCH_RECOMMENDED_LOYALTY_PERCENT,
  };

  let padcoinsConfig = await getPadcoinsSedeConfig(supabaseAdmin, sid, { now });

  if (!padcoinsConfig.id) {
    padcoinsConfig = await upsertPadcoinsSedeConfig(supabaseAdmin, {
      sede_id: sid,
      activo: true,
      descripcion: descripcion ?? `PadCoins — ${sede.nombre}`,
      updated_by: actor_user_id,
    });
    summary.created.push('padcoins_sede_config');
  } else if (!padcoinsConfig.activo) {
    padcoinsConfig = await upsertPadcoinsSedeConfig(supabaseAdmin, {
      sede_id: sid,
      activo: true,
      descripcion: padcoinsConfig.descripcion ?? descripcion ?? `PadCoins — ${sede.nombre}`,
      fecha_inicio: padcoinsConfig.fecha_inicio,
      fecha_fin: padcoinsConfig.fecha_fin,
      updated_by: actor_user_id,
    });
    summary.updated.push('padcoins_sede_config.activo');
  } else {
    summary.already_existed.push('padcoins_sede_config');
  }

  const existingOverrides = normalizePadcoinsSedeRuleOverrides(padcoinsConfig.rule_overrides);

  if (Object.prototype.hasOwnProperty.call(existingOverrides, 'padcoins_por_usd_equivalente')) {
    summary.skipped.push('padcoins_por_usd_equivalente_override');
    summary.missing.push('remover_override_conversion_sede_si_existe');
  } else {
    summary.already_existed.push('conversion_global_heredada');
  }

  if (Object.prototype.hasOwnProperty.call(existingOverrides, 'porcentaje_devolucion_reserva')) {
    const current = existingOverrides.porcentaje_devolucion_reserva;
    if (isRecommendedLoyaltyPercent(current)) {
      summary.already_existed.push('porcentaje_devolucion_reserva_5');
    } else {
      summary.skipped.push(`porcentaje_devolucion_reserva_override_${current}`);
    }
  } else {
    await updatePadcoinsSedeRuleOverrides(supabaseAdmin, {
      sede_id: sid,
      rule_overrides: {
        ...existingOverrides,
        porcentaje_devolucion_reserva: PADBOL_MATCH_RECOMMENDED_LOYALTY_PERCENT,
      },
      updated_by: actor_user_id,
    });
    summary.created.push('porcentaje_devolucion_reserva_5');
  }

  if (seed_beneficios) {
    const seedResult = await seedSuggestedPremios(supabaseAdmin, sid, { actor_user_id });
    for (const item of seedResult.created) {
      summary.created.push(`premio:${item.nombre}`);
    }
    for (const item of seedResult.skipped) {
      summary.already_existed.push(`premio:${item.nombre}`);
    }
  }

  const validation = await validateSetupForSede(supabaseAdmin, sid, { now });

  if (!validation.flags.admin_sede_configurado) {
    summary.missing.push(PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO);
  }
  if (!validation.flags.beneficios_iniciales_configurados) {
    summary.missing.push(PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS);
  }
  if (!validation.flags.reserva_visible_para_jugador) {
    summary.missing.push(PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR);
  }

  return {
    ok: true,
    summary,
    validation,
    padcoins: {
      activo: validation.flags.padcoins_activado,
      participa: validation.flags.padcoins_activado,
      porcentaje_efectivo: validation.flags.meta?.effective_porcentaje_devolucion_reserva,
      conversion_global: validation.flags.meta?.global_padcoins_por_unidad_interna,
    },
  };
}

export async function markSetupStep(supabaseAdmin, sedeId, step, value, {
  notes = null,
} = {}) {
  const sid = parseSedeId(sedeId);
  if (!sid) throw buildHttpError('sede_id inválido');

  const normalizedStep = String(step ?? '').trim();
  if (!PADBOL_MATCH_SETUP_STEP_KEYS.includes(normalizedStep)) {
    throw buildHttpError(`step inválido: ${normalizedStep}`);
  }

  if (typeof value !== 'boolean') {
    throw buildHttpError('value debe ser boolean');
  }

  await assertSedeExists(supabaseAdmin, sid);

  const existing = normalizeSetupStatusRow(
    await fetchSetupStatusRow(supabaseAdmin, sid),
    sid,
  );

  const payload = {
    sede_id: sid,
    admin_sede_configurado: existing.admin_sede_configurado,
    padcoins_activado: existing.padcoins_activado,
    padcoins_default_5_configurado: existing.padcoins_default_5_configurado,
    beneficios_iniciales_configurados: existing.beneficios_iniciales_configurados,
    campanas_habilitadas: existing.campanas_habilitadas,
    reserva_visible_para_jugador: existing.reserva_visible_para_jugador,
    checklist_completo: existing.checklist_completo,
    last_checked_at: existing.last_checked_at,
    notes: notes != null ? notes : existing.notes,
  };

  if (normalizedStep === PADBOL_MATCH_SETUP_STEPS.CHECKLIST_COMPLETO) {
    payload.checklist_completo = value;
  } else if (BOOLEAN_STEP_COLUMNS.has(normalizedStep)) {
    payload[normalizedStep] = value;
  }

  const saved = await upsertSetupStatusRow(supabaseAdmin, payload);

  return {
    sede_id: sid,
    step: normalizedStep,
    value,
    status: saved,
  };
}

export {
  SETUP_STATUS_SELECT,
  BOOLEAN_STEP_COLUMNS,
  buildValidationFromFlags,
  computeDerivedSetupFlags,
};
