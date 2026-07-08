export const PADBOL_MATCH_SETUP_PHASE2_STEPS = Object.freeze({
  SEDE_DATOS_BASICOS_CONFIGURADOS: 'sede_datos_basicos_configurados',
  CANCHAS_CONFIGURADAS: 'canchas_configuradas',
  HORARIOS_CONFIGURADOS: 'horarios_configurados',
  PRECIOS_CONFIGURADOS: 'precios_configurados',
  RESERVAS_HABILITADAS: 'reservas_habilitadas',
  PAGOS_CONFIGURADOS: 'pagos_configurados',
  REGLAS_OPERATIVAS_CONFIGURADAS: 'reglas_operativas_configuradas',
});

export const PADBOL_MATCH_SETUP_PHASE2_STEP_KEYS = Object.freeze([
  PADBOL_MATCH_SETUP_PHASE2_STEPS.SEDE_DATOS_BASICOS_CONFIGURADOS,
  PADBOL_MATCH_SETUP_PHASE2_STEPS.CANCHAS_CONFIGURADAS,
  PADBOL_MATCH_SETUP_PHASE2_STEPS.HORARIOS_CONFIGURADOS,
  PADBOL_MATCH_SETUP_PHASE2_STEPS.PRECIOS_CONFIGURADOS,
  PADBOL_MATCH_SETUP_PHASE2_STEPS.RESERVAS_HABILITADAS,
  PADBOL_MATCH_SETUP_PHASE2_STEPS.PAGOS_CONFIGURADOS,
  PADBOL_MATCH_SETUP_PHASE2_STEPS.REGLAS_OPERATIVAS_CONFIGURADAS,
]);

export const PADBOL_MATCH_READINESS_LEVELS = Object.freeze({
  INCOMPLETE: 'incomplete',
  BASIC: 'basic',
  OPERATIONAL: 'operational',
  READY: 'ready',
});

export const PADBOL_MATCH_SETUP_SECTIONS = Object.freeze({
  IDENTIDAD_SEDE: 'identidad_sede',
  ADMINISTRACION: 'administracion',
  RESERVAS: 'reservas',
  PADCOINS: 'padcoins',
  BENEFICIOS: 'beneficios',
  CAMPANAS: 'campanas',
  PAGOS: 'pagos',
  REGLAS_OPERATIVAS: 'reglas_operativas',
});

export const PADBOL_MATCH_SETUP_SECTION_TITLES = Object.freeze({
  [PADBOL_MATCH_SETUP_SECTIONS.IDENTIDAD_SEDE]: 'Identidad de sede',
  [PADBOL_MATCH_SETUP_SECTIONS.ADMINISTRACION]: 'Administración',
  [PADBOL_MATCH_SETUP_SECTIONS.RESERVAS]: 'Reservas',
  [PADBOL_MATCH_SETUP_SECTIONS.PADCOINS]: 'PadCoins',
  [PADBOL_MATCH_SETUP_SECTIONS.BENEFICIOS]: 'Beneficios',
  [PADBOL_MATCH_SETUP_SECTIONS.CAMPANAS]: 'Campañas',
  [PADBOL_MATCH_SETUP_SECTIONS.PAGOS]: 'Pagos',
  [PADBOL_MATCH_SETUP_SECTIONS.REGLAS_OPERATIVAS]: 'Reglas operativas',
});

export const PADBOL_MATCH_SETUP_PHASE2_LABELS = Object.freeze({
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.SEDE_DATOS_BASICOS_CONFIGURADOS]: 'Datos básicos de sede',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.CANCHAS_CONFIGURADAS]: 'Canchas activas configuradas',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.HORARIOS_CONFIGURADOS]: 'Horarios o disponibilidad',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.PRECIOS_CONFIGURADOS]: 'Precio de turno configurado',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.RESERVAS_HABILITADAS]: 'Reservas habilitadas',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.PAGOS_CONFIGURADOS]: 'Medios de pago configurados',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.REGLAS_OPERATIVAS_CONFIGURADAS]: 'Reglas de cancelación y no-show',
});

export const PADBOL_MATCH_SETUP_PHASE2_NEXT_ACTIONS = Object.freeze({
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.SEDE_DATOS_BASICOS_CONFIGURADOS]:
    'Completar nombre, ubicación y datos visibles al jugador en el perfil de la sede.',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.CANCHAS_CONFIGURADAS]:
    'Cargar al menos una cancha activa con nombre o número para reservas.',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.HORARIOS_CONFIGURADOS]:
    'Configurar horario_apertura y horario_cierre en la sede o franjas en franjas_precio.',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.PRECIOS_CONFIGURADOS]:
    'Definir precio_90min, precio_turno o franjas_precio con valores para cotizar turnos.',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.RESERVAS_HABILITADAS]:
    'Completar identidad, canchas, horarios y precios para habilitar reservas.',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.PAGOS_CONFIGURADOS]:
    'Configurar metodo_pago y credenciales (Mercado Pago, Stripe o pago manual).',
  [PADBOL_MATCH_SETUP_PHASE2_STEPS.REGLAS_OPERATIVAS_CONFIGURADAS]:
    'Futuro: reglas por sede. Hoy aplican penalizaciones globales PadCoins y reputación.',
});

export const CANCHA_ESTADOS_BLOQUEADOS = Object.freeze([
  'inactiva',
  'inactivo',
  'mantenimiento',
  'bloqueada',
  'cerrada',
]);

export const SEDE_OPERATIONAL_SELECT = [
  'id',
  'nombre',
  'ciudad',
  'provincia',
  'direccion',
  'latitud',
  'longitud',
  'horario_apertura',
  'horario_cierre',
  'precio_60min',
  'precio_90min',
  'precio_120min',
  'precio_turno',
  'precio_por_reserva',
  'metodo_pago',
  'pago_manual_instrucciones',
  'mp_access_token',
  'stripe_account_id',
].join(', ');
