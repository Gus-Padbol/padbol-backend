export const PADBOL_MATCH_SETUP_STEPS = Object.freeze({
  ADMIN_SEDE_CONFIGURADO: 'admin_sede_configurado',
  PADCOINS_ACTIVADO: 'padcoins_activado',
  PADCOINS_DEFAULT_5_CONFIGURADO: 'padcoins_default_5_configurado',
  BENEFICIOS_INICIALES_CONFIGURADOS: 'beneficios_iniciales_configurados',
  CAMPANAS_HABILITADAS: 'campanas_habilitadas',
  RESERVA_VISIBLE_PARA_JUGADOR: 'reserva_visible_para_jugador',
  CHECKLIST_COMPLETO: 'checklist_completo',
});

export const PADBOL_MATCH_SETUP_STEP_KEYS = Object.freeze([
  PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO,
  PADBOL_MATCH_SETUP_STEPS.PADCOINS_ACTIVADO,
  PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO,
  PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS,
  PADBOL_MATCH_SETUP_STEPS.CAMPANAS_HABILITADAS,
  PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR,
  PADBOL_MATCH_SETUP_STEPS.CHECKLIST_COMPLETO,
]);

export const PADBOL_MATCH_RECOMMENDED_LOYALTY_PERCENT = 5;

export const PADBOL_MATCH_GLOBAL_PADCOINS_PER_UNIT = 100;

/** Beneficios sugeridos de fidelización (sin equivalencia monetaria para jugador). */
export const PADBOL_MATCH_SUGGESTED_PREMIOS = Object.freeze([
  {
    nombre: 'Bebida post partido',
    descripcion: 'Bebida de cortesía al canjear PadCoins tras jugar en la sede.',
    costo_padcoins: 150,
    stock_total: 50,
  },
  {
    nombre: 'Descuento en próximo turno',
    descripcion: 'Beneficio de fidelización para tu siguiente reserva en esta sede.',
    costo_padcoins: 400,
    stock_total: 30,
  },
  {
    nombre: 'Merchandising Padbol',
    descripcion: 'Artículo promocional de la sede canjeable con PadCoins.',
    costo_padcoins: 800,
    stock_total: 20,
  },
]);

export const PADBOL_MATCH_SETUP_CHECKLIST_LABELS = Object.freeze({
  [PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO]: 'Administrador de sede asignado',
  [PADBOL_MATCH_SETUP_STEPS.PADCOINS_ACTIVADO]: 'PadCoins activado en la sede',
  [PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO]: 'Fidelización recomendada al 5%',
  [PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS]: 'Beneficios iniciales cargados',
  [PADBOL_MATCH_SETUP_STEPS.CAMPANAS_HABILITADAS]: 'Campañas PadCoins habilitadas',
  [PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR]: 'Reserva visible para jugador',
});

export const PADBOL_MATCH_SETUP_NEXT_ACTIONS = Object.freeze({
  [PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO]: 'Asignar un Admin Club con sede_id en user_roles.',
  [PADBOL_MATCH_SETUP_STEPS.PADCOINS_ACTIVADO]: 'Inicializar PadCoins para la sede (Super Admin).',
  [PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO]: 'Aplicar fidelización recomendada del 5% sin override distinto.',
  [PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS]: 'Cargar al menos un beneficio canjeable en premios_canjeables.',
  [PADBOL_MATCH_SETUP_STEPS.CAMPANAS_HABILITADAS]: 'Activar PadCoins y habilitar campañas para la sede.',
  [PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR]: 'Completar perfil de sede y al menos una cancha para reservar.',
});

/** Checklist Fase 1 — se mantiene sin cambios para compatibilidad. */
export const PADBOL_MATCH_SETUP_PHASE1_CHECKLIST_KEYS = Object.freeze([
  PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO,
  PADBOL_MATCH_SETUP_STEPS.PADCOINS_ACTIVADO,
  PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO,
  PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS,
  PADBOL_MATCH_SETUP_STEPS.CAMPANAS_HABILITADAS,
  PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR,
]);
