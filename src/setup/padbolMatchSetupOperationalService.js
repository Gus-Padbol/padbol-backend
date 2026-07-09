import {
  CANCHA_ESTADOS_BLOQUEADOS,
  PADBOL_MATCH_READINESS_LEVELS,
  PADBOL_MATCH_SETUP_PHASE2_LABELS,
  PADBOL_MATCH_SETUP_PHASE2_NEXT_ACTIONS,
  PADBOL_MATCH_SETUP_PHASE2_STEPS,
  PADBOL_MATCH_SETUP_SECTIONS,
  PADBOL_MATCH_SETUP_SECTION_TITLES,
  SEDE_OPERATIONAL_SELECT,
} from './padbolMatchSetupPhase2Config.js';
import { PADBOL_MATCH_SETUP_STEPS } from './padbolMatchSetupConfig.js';
import { buildBeneficiosSectionPayload } from './padbolMatchSetupBenefitsService.js';
import { buildLoyaltyPolicySectionFields } from '../padcoins/padcoinsLoyaltyPolicyService.js';
import { PADCOINS_GLOBAL_CONFIG_DEFAULTS } from '../padcoins/padcoinsGlobalConfigService.js';

const CANCHA_SELECT = 'id, sede_id, nombre, numero, nro, estado, deporte';
const DEFAULT_RESERVA_DURACION_MIN = 90;

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function parsePrecioInt(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function hasText(value) {
  return Boolean(String(value ?? '').trim());
}

function canchaTieneIdentificador(cancha) {
  if (hasText(cancha?.nombre)) return true;
  if (cancha?.numero != null && String(cancha.numero).trim() !== '') return true;
  if (cancha?.nro != null && String(cancha.nro).trim() !== '') return true;
  return false;
}

export function isCanchaActivaParaReserva(cancha) {
  if (!cancha?.id) return false;
  const estado = String(cancha?.estado ?? '').trim().toLowerCase();
  if (estado && CANCHA_ESTADOS_BLOQUEADOS.includes(estado)) return false;
  return canchaTieneIdentificador(cancha);
}

export function sedeTieneUbicacionVisible(sede) {
  if (!sede) return false;
  if (hasText(sede.ciudad) || hasText(sede.direccion) || hasText(sede.provincia)) return true;
  if (sede.latitud == null || sede.longitud == null) return false;
  const lat = Number(sede.latitud);
  const lng = Number(sede.longitud);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

export function sedeTieneDatosBasicos(sede) {
  return hasText(sede?.nombre) && sedeTieneUbicacionVisible(sede);
}

export function sedeTieneHorariosConfigurados(sede, franjasCount = 0) {
  const apertura = String(sede?.horario_apertura ?? '').trim();
  const cierre = String(sede?.horario_cierre ?? '').trim();
  return (Boolean(apertura) && Boolean(cierre)) || franjasCount > 0;
}

export function sedeTienePrecioTurno(sede, franjas = []) {
  const duracion = DEFAULT_RESERVA_DURACION_MIN;
  const colMap = { 60: 'precio_60min', 90: 'precio_90min', 120: 'precio_120min' };
  const col = colMap[duracion];

  if (col) {
    const fromCol = parsePrecioInt(sede?.[col]);
    if (fromCol != null && fromCol > 0) return true;
  }

  if (duracion === 90) {
    const legacy = parsePrecioInt(sede?.precio_turno);
    if (legacy != null && legacy > 0) return true;
    const ppr = parsePrecioInt(sede?.precio_por_reserva);
    if (ppr != null && ppr > 0) return true;
  }

  for (const franja of franjas) {
    const precioFranja = parsePrecioInt(franja?.[col]);
    if (precioFranja != null && precioFranja > 0) return true;
  }

  return false;
}

export function sedeTienePagosConfigurados(sede) {
  if (!sede) return { configured: false, mode: null, detail: 'Sin configuración de pagos' };

  const metodo = String(sede.metodo_pago ?? '').trim().toLowerCase();
  const mpToken = hasText(sede.mp_access_token);
  const stripeAccount = hasText(sede.stripe_account_id);
  const manualInstrucciones = hasText(sede.pago_manual_instrucciones);

  if (metodo.includes('stripe') && stripeAccount) {
    return { configured: true, mode: 'stripe', detail: 'Stripe configurado para la sede' };
  }

  if ((metodo.includes('mercado') || metodo.includes('mp')) && mpToken) {
    return { configured: true, mode: 'mercado_pago', detail: 'Mercado Pago configurado para la sede' };
  }

  if (mpToken) {
    return { configured: true, mode: 'mercado_pago', detail: 'Mercado Pago (token) configurado' };
  }

  if (stripeAccount) {
    return { configured: true, mode: 'stripe', detail: 'Stripe (cuenta) configurada' };
  }

  if (metodo.includes('manual') && manualInstrucciones) {
    return { configured: true, mode: 'manual', detail: 'Pago manual con instrucciones' };
  }

  if (manualInstrucciones) {
    return { configured: true, mode: 'manual', detail: 'Instrucciones de pago manual cargadas' };
  }

  if (metodo) {
    return {
      configured: false,
      mode: metodo,
      detail: `metodo_pago=${metodo} sin credenciales ni instrucciones`,
    };
  }

  return { configured: false, mode: null, detail: 'Sin metodo_pago ni integración cargada' };
}

export function evaluarReglasOperativasGlobales() {
  const cancelacion = PADCOINS_GLOBAL_CONFIG_DEFAULTS.cancelacion_tarde;
  const noShow = PADCOINS_GLOBAL_CONFIG_DEFAULTS.no_show;

  const globalActivo = Number.isFinite(cancelacion) && Number.isFinite(noShow);

  return {
    configured: globalActivo,
    pending_sede_config: true,
    detail: globalActivo
      ? 'Penalizaciones globales PadCoins activas (cancelación tardía / no-show). Configuración por sede: pendiente futuro.'
      : 'Penalizaciones globales PadCoins no disponibles',
    source: 'padcoins_global_config',
  };
}

async function fetchSedeOperationalRow(supabaseAdmin, sedeId) {
  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select(SEDE_OPERATIONAL_SELECT)
    .eq('id', sedeId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function fetchCanchasForSede(supabaseAdmin, sedeId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('canchas')
      .select(CANCHA_SELECT)
      .eq('sede_id', sedeId);

    if (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }

    return data ?? [];
  } catch (err) {
    if (isMissingTable(err)) return [];
    return [];
  }
}

async function fetchFranjasPrecioForSede(supabaseAdmin, sedeId) {
  try {
    const { data, error } = await supabaseAdmin
      .from('franjas_precio')
      .select('id, sede_id, dia_semana, hora_inicio, hora_fin, precio_60min, precio_90min, precio_120min, activo')
      .eq('sede_id', sedeId)
      .eq('activo', true);

    if (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }

    return data ?? [];
  } catch (err) {
    if (isMissingTable(err)) return [];
    return [];
  }
}

function buildSectionItem(key, label, ok, detail, statusOverride = null) {
  return {
    key,
    label,
    status: statusOverride ?? (ok ? 'ok' : 'missing'),
    detail,
  };
}

function deriveSectionStatus(items) {
  if (items.every((item) => item.status === 'ok')) return 'ok';
  if (items.some((item) => item.status === 'ok')) return 'partial';
  if (items.some((item) => item.status === 'pending')) return 'pending';
  return 'missing';
}

export function computeReadinessLevel(flags, phase1Complete) {
  const {
    sede_datos_basicos_configurados: datosBasicos,
    canchas_configuradas: canchas,
    admin_sede_configurado: admin,
    horarios_configurados: horarios,
    precios_configurados: precios,
    reservas_habilitadas: reservas,
    padcoins_activado: padcoins,
    padcoins_default_5_configurado: padcoins5,
    beneficios_iniciales_configurados: beneficios,
    campanas_habilitadas: campanas,
    pagos_configurados: pagos,
  } = flags;

  if (!datosBasicos || !canchas) {
    return PADBOL_MATCH_READINESS_LEVELS.INCOMPLETE;
  }

  const basicReady = datosBasicos && admin && canchas;
  if (!basicReady) {
    return PADBOL_MATCH_READINESS_LEVELS.INCOMPLETE;
  }

  const operationalReady = basicReady && horarios && precios && reservas;
  if (!operationalReady) {
    return PADBOL_MATCH_READINESS_LEVELS.BASIC;
  }

  const padcoinsReady = padcoins && padcoins5 && beneficios && campanas;
  const readyExtras = padcoinsReady && pagos && phase1Complete;

  if (readyExtras) {
    return PADBOL_MATCH_READINESS_LEVELS.READY;
  }

  return PADBOL_MATCH_READINESS_LEVELS.OPERATIONAL;
}

export function buildSetupSections(flags, phase1Checklist) {
  const pagos = flags.meta?.pagos ?? sedeTienePagosConfigurados(null);
  const reglas = flags.meta?.reglas_operativas ?? evaluarReglasOperativasGlobales();

  const identidadItems = [
    buildSectionItem(
      PADBOL_MATCH_SETUP_PHASE2_STEPS.SEDE_DATOS_BASICOS_CONFIGURADOS,
      PADBOL_MATCH_SETUP_PHASE2_LABELS[PADBOL_MATCH_SETUP_PHASE2_STEPS.SEDE_DATOS_BASICOS_CONFIGURADOS],
      flags.sede_datos_basicos_configurados === true,
      flags.sede_datos_basicos_configurados
        ? `Sede visible: ${flags.meta?.sede_nombre ?? '—'}`
        : 'Faltan nombre o ubicación visible al jugador',
    ),
  ];

  const administracionItems = [
    buildSectionItem(
      PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO,
      'Administrador de sede asignado',
      flags.admin_sede_configurado === true,
      flags.admin_sede_configurado ? 'Admin Club asignado' : 'Sin Admin Club en user_roles',
    ),
  ];

  const reservasItems = [
    buildSectionItem(
      PADBOL_MATCH_SETUP_PHASE2_STEPS.CANCHAS_CONFIGURADAS,
      PADBOL_MATCH_SETUP_PHASE2_LABELS[PADBOL_MATCH_SETUP_PHASE2_STEPS.CANCHAS_CONFIGURADAS],
      flags.canchas_configuradas === true,
      flags.canchas_configuradas
        ? `${flags.meta?.canchas_activas_count ?? 0} cancha(s) activa(s)`
        : 'Sin canchas activas con nombre o número',
    ),
    buildSectionItem(
      PADBOL_MATCH_SETUP_PHASE2_STEPS.HORARIOS_CONFIGURADOS,
      PADBOL_MATCH_SETUP_PHASE2_LABELS[PADBOL_MATCH_SETUP_PHASE2_STEPS.HORARIOS_CONFIGURADOS],
      flags.horarios_configurados === true,
      flags.horarios_configurados
        ? flags.meta?.horarios_source ?? 'Horarios configurados'
        : 'Configurar horario_apertura/cierre o franjas_precio',
    ),
    buildSectionItem(
      PADBOL_MATCH_SETUP_PHASE2_STEPS.PRECIOS_CONFIGURADOS,
      PADBOL_MATCH_SETUP_PHASE2_LABELS[PADBOL_MATCH_SETUP_PHASE2_STEPS.PRECIOS_CONFIGURADOS],
      flags.precios_configurados === true,
      flags.precios_configurados
        ? flags.meta?.precio_source ?? 'Precio de turno disponible'
        : 'Falta precio_90min, precio_turno o franja con precio',
    ),
    buildSectionItem(
      PADBOL_MATCH_SETUP_PHASE2_STEPS.RESERVAS_HABILITADAS,
      PADBOL_MATCH_SETUP_PHASE2_LABELS[PADBOL_MATCH_SETUP_PHASE2_STEPS.RESERVAS_HABILITADAS],
      flags.reservas_habilitadas === true,
      flags.reservas_habilitadas
        ? 'Condiciones mínimas para recibir reservas'
        : 'Completar identidad, canchas, horarios y precios',
    ),
    buildSectionItem(
      PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR,
      'Reserva visible para jugador',
      flags.reserva_visible_para_jugador === true,
      phase1Checklist?.find((i) => i.key === PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR)?.detail
        ?? (flags.reserva_visible_para_jugador ? 'Visible en flujo jugador' : 'Pendiente'),
    ),
  ];

  const padcoinsItems = phase1Checklist
    ?.filter((item) => [
      PADBOL_MATCH_SETUP_STEPS.PADCOINS_ACTIVADO,
      PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO,
    ].includes(item.key))
    .map((item) => buildSectionItem(item.key, item.label, item.status === 'ok', item.detail))
    ?? [];

  const beneficiosExtras = buildBeneficiosSectionPayload(flags);
  const beneficiosItems = [
    buildSectionItem(
      PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS,
      'Beneficios iniciales cargados',
      flags.beneficios_iniciales_configurados === true,
      beneficiosExtras.detail,
    ),
  ];

  const loyaltyPolicyFields = buildLoyaltyPolicySectionFields(flags);

  const padcoinsSection = {
    key: PADBOL_MATCH_SETUP_SECTIONS.PADCOINS,
    title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.PADCOINS],
    status: deriveSectionStatus(padcoinsItems),
    items: padcoinsItems,
    ...loyaltyPolicyFields,
  };

  const beneficiosSection = {
    key: PADBOL_MATCH_SETUP_SECTIONS.BENEFICIOS,
    title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.BENEFICIOS],
    status: beneficiosExtras.status,
    detail: beneficiosExtras.detail,
    items: beneficiosItems,
    recommendations: beneficiosExtras.recommendations,
    warnings: [
      ...(beneficiosExtras.warnings ?? []),
      ...(loyaltyPolicyFields.loyalty_policy_warnings ?? []),
    ],
    loyalty_quality: beneficiosExtras.loyalty_quality,
    evaluation_summary: beneficiosExtras.evaluation_summary,
    ...loyaltyPolicyFields,
  };

  const campanasItems = [
    buildSectionItem(
      PADBOL_MATCH_SETUP_STEPS.CAMPANAS_HABILITADAS,
      'Campañas PadCoins habilitadas',
      flags.campanas_habilitadas === true,
      flags.campanas_habilitadas
        ? 'PadCoins activo — campañas disponibles'
        : 'Activar PadCoins antes de campañas',
    ),
  ];

  const pagosItems = [
    buildSectionItem(
      PADBOL_MATCH_SETUP_PHASE2_STEPS.PAGOS_CONFIGURADOS,
      PADBOL_MATCH_SETUP_PHASE2_LABELS[PADBOL_MATCH_SETUP_PHASE2_STEPS.PAGOS_CONFIGURADOS],
      flags.pagos_configurados === true,
      pagos.detail ?? 'Pendiente',
    ),
  ];

  const reglasItems = [
    buildSectionItem(
      PADBOL_MATCH_SETUP_PHASE2_STEPS.REGLAS_OPERATIVAS_CONFIGURADAS,
      PADBOL_MATCH_SETUP_PHASE2_LABELS[PADBOL_MATCH_SETUP_PHASE2_STEPS.REGLAS_OPERATIVAS_CONFIGURADAS],
      flags.reglas_operativas_configuradas === true,
      reglas.detail,
      reglas.pending_sede_config ? 'pending' : (reglas.configured ? 'ok' : 'missing'),
    ),
  ];

  return [
    {
      key: PADBOL_MATCH_SETUP_SECTIONS.IDENTIDAD_SEDE,
      title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.IDENTIDAD_SEDE],
      status: deriveSectionStatus(identidadItems),
      items: identidadItems,
    },
    {
      key: PADBOL_MATCH_SETUP_SECTIONS.ADMINISTRACION,
      title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.ADMINISTRACION],
      status: deriveSectionStatus(administracionItems),
      items: administracionItems,
    },
    {
      key: PADBOL_MATCH_SETUP_SECTIONS.RESERVAS,
      title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.RESERVAS],
      status: deriveSectionStatus(reservasItems),
      items: reservasItems,
    },
    padcoinsSection,
    beneficiosSection,
    {
      key: PADBOL_MATCH_SETUP_SECTIONS.CAMPANAS,
      title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.CAMPANAS],
      status: deriveSectionStatus(campanasItems),
      items: campanasItems,
    },
    {
      key: PADBOL_MATCH_SETUP_SECTIONS.PAGOS,
      title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.PAGOS],
      status: deriveSectionStatus(pagosItems),
      items: pagosItems,
    },
    {
      key: PADBOL_MATCH_SETUP_SECTIONS.REGLAS_OPERATIVAS,
      title: PADBOL_MATCH_SETUP_SECTION_TITLES[PADBOL_MATCH_SETUP_SECTIONS.REGLAS_OPERATIVAS],
      status: deriveSectionStatus(reglasItems),
      items: reglasItems,
    },
  ];
}

export async function computePhase2OperationalFlags(supabaseAdmin, sedeId) {
  const [sede, canchas, franjas] = await Promise.all([
    fetchSedeOperationalRow(supabaseAdmin, sedeId),
    fetchCanchasForSede(supabaseAdmin, sedeId),
    fetchFranjasPrecioForSede(supabaseAdmin, sedeId),
  ]);

  const canchasActivas = canchas.filter(isCanchaActivaParaReserva);
  const datosBasicos = sedeTieneDatosBasicos(sede);
  const canchasOk = canchasActivas.length > 0;
  const horariosOk = sedeTieneHorariosConfigurados(sede, franjas.length);
  const preciosOk = sedeTienePrecioTurno(sede, franjas);
  const pagosEval = sedeTienePagosConfigurados(sede);
  const reglasEval = evaluarReglasOperativasGlobales();

  const reservasHabilitadas = datosBasicos && canchasOk && horariosOk && preciosOk;

  let horariosSource = null;
  if (horariosOk) {
    const apertura = String(sede?.horario_apertura ?? '').trim();
    const cierre = String(sede?.horario_cierre ?? '').trim();
    if (apertura && cierre) horariosSource = `Horario sede ${apertura} – ${cierre}`;
    else if (franjas.length > 0) horariosSource = `${franjas.length} franja(s) en franjas_precio`;
  }

  let precioSource = null;
  let precioTurnoReferencia = null;
  if (preciosOk) {
    precioTurnoReferencia = resolveTurnPriceReference(sede, franjas);
    if (parsePrecioInt(sede?.precio_90min) > 0) precioSource = 'precio_90min en sedes';
    else if (parsePrecioInt(sede?.precio_turno) > 0) precioSource = 'precio_turno en sedes';
    else if (parsePrecioInt(sede?.precio_por_reserva) > 0) precioSource = 'precio_por_reserva en sedes';
    else precioSource = 'franjas_precio activas';
  }

  return {
    sede_datos_basicos_configurados: datosBasicos,
    canchas_configuradas: canchasOk,
    horarios_configurados: horariosOk,
    precios_configurados: preciosOk,
    reservas_habilitadas: reservasHabilitadas,
    pagos_configurados: pagosEval.configured,
    reglas_operativas_configuradas: reglasEval.configured,
    meta: {
      sede_nombre: sede?.nombre ?? null,
      canchas_total: canchas.length,
      canchas_activas_count: canchasActivas.length,
      franjas_precio_count: franjas.length,
      horarios_source: horariosSource,
      precio_source: precioSource,
      precio_turno_referencia: precioTurnoReferencia,
      pagos: pagosEval,
      reglas_operativas: reglasEval,
    },
  };
}

export function buildPhase2MissingAndActions(flags) {
  const phase2Keys = [
    PADBOL_MATCH_SETUP_PHASE2_STEPS.SEDE_DATOS_BASICOS_CONFIGURADOS,
    PADBOL_MATCH_SETUP_PHASE2_STEPS.CANCHAS_CONFIGURADAS,
    PADBOL_MATCH_SETUP_PHASE2_STEPS.HORARIOS_CONFIGURADOS,
    PADBOL_MATCH_SETUP_PHASE2_STEPS.PRECIOS_CONFIGURADOS,
    PADBOL_MATCH_SETUP_PHASE2_STEPS.RESERVAS_HABILITADAS,
    PADBOL_MATCH_SETUP_PHASE2_STEPS.PAGOS_CONFIGURADOS,
  ];

  const missing = [];
  const next_actions = [];

  for (const key of phase2Keys) {
    if (flags[key] !== true) {
      missing.push(key);
      const action = PADBOL_MATCH_SETUP_PHASE2_NEXT_ACTIONS[key];
      if (action) next_actions.push(action);
    }
  }

  if (flags.reglas_operativas_configuradas !== true) {
    missing.push(PADBOL_MATCH_SETUP_PHASE2_STEPS.REGLAS_OPERATIVAS_CONFIGURADAS);
    next_actions.push(PADBOL_MATCH_SETUP_PHASE2_NEXT_ACTIONS[PADBOL_MATCH_SETUP_PHASE2_STEPS.REGLAS_OPERATIVAS_CONFIGURADAS]);
  }

  return { missing, next_actions };
}

function resolveTurnPriceReference(sede, franjas = []) {
  const from90 = parsePrecioInt(sede?.precio_90min);
  if (from90 != null && from90 > 0) return from90;

  const fromTurno = parsePrecioInt(sede?.precio_turno);
  if (fromTurno != null && fromTurno > 0) return fromTurno;

  const fromPpr = parsePrecioInt(sede?.precio_por_reserva);
  if (fromPpr != null && fromPpr > 0) return fromPpr;

  for (const franja of franjas) {
    const fromFranja = parsePrecioInt(franja?.precio_90min);
    if (fromFranja != null && fromFranja > 0) return fromFranja;
  }

  return null;
}

export {
  fetchSedeOperationalRow,
  fetchCanchasForSede,
  fetchFranjasPrecioForSede,
  resolveTurnPriceReference,
};
