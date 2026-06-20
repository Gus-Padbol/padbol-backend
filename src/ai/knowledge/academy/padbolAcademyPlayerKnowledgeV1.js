export const PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION = '1.1.0';

/**
 * Conocimiento práctico Padbol Academy para jugadores.
 * Orientación formativa; no sustituye entrenamiento en pista ni programas oficiales.
 */
export const PADBOL_ACADEMY_PLAYER_SECTIONS = {
  playerProgression: `PROGRESIÓN DEL JUGADOR
Iniciación: conocer pista, reglas básicas y pelota oficial antes de buscar potencia.
Adaptación al peso del balón: priorizar control y toque suave en las primeras sesiones.
Control corporal: equilibrio, base amplia y mirada al compañero y al rival.
Aprender a combinar con el compañero antes de atacar: construir el punto en equipo.
Progresión básico → intermedio: dominar servicio, recepción y pase; luego variar cristales y remates.`,

  technicalFoundations: `FUNDAMENTOS TÉCNICOS
Interior del pie: superficie principal para control, recepción y pase preciso.
Empeine: potencia y efecto cuando ya domina el control con interior.
Cabeza y volea: recursos de finalización según altura y tiempo de la pelota.
Chilena: recurso avanzado; practicar solo con supervisión y progresión adecuada.
Usar superficies de juego permitidas (pie, muslo, cabeza, etc.); brazos y manos no son válidos salvo reglamento específico.`,

  tacticalUnderstanding: `COMPRENSIÓN TÁCTICA
Construir con primer toque (salir de presión), segundo toque (colocación) y tercer toque (remate).
Elegir cuándo jugar con cristales: defensa, cambio de ángulo o salida combinada, no en cada toque.
Variar servicios cuando el rival se adapta: directo, cristal lateral, doble cristal o a puerta.
Leer al rival: postura, pierna de apoyo y preparación antes del impacto.
No regalar el primer toque: evitar devolver al punto rival sin orientación.`,

  positioningForPlayers: `UBICACIÓN PARA JUGADORES
Ideal habitual: diestro en banda izquierda; zurdo en banda derecha.
Definir roles de colocador (arma la jugada) y rematador (cierra cuando hay ventaja).
Defensa sincronizada: diagonal con el compañero y cobertura de huecos centrales.
Recepción de saque: cerca de puerta o fondo según pierna dominante y tipo de servicio rival.`,

  commonMistakes: `ERRORES FRECUENTES
Pegar demasiado fuerte en el saque sin control de bote ni dirección.
Impactar mal el bote: muy bajo, muy tarde o fuera del punto alto recomendado.
Usar cristales bajos en pases combinativos (rebote impredecible).
No perfilarse hacia el compañero antes de pasar (pase sin visión ni apoyo).
Atacar sin construir: forzar remate en el segundo toque sin ventaja táctica.`,

  trainingTips: `CONSEJOS DE ENTRENAMIENTO
Servicio: repetir saque cruzado con bote previo; apuntar a zonas de recepción.
Recepción: primer toque orientado hacia compañero o cristal seguro.
Pase al compañero: interior del pie, mirada previa y comunicación verbal.
Cristales: ejercicios de pared alta vs evitar zona media-baja.
Remate: precisión antes que potencia; volea y cabeza en situaciones controladas.
Defensa y bloqueo: parejas en diagonal; bloqueo ante voleas sin perder cobertura.`,
};

export const PADBOL_ACADEMY_PLAYER_SECTION_ORDER = [
  'playerProgression',
  'technicalFoundations',
  'tacticalUnderstanding',
  'positioningForPlayers',
  'commonMistakes',
  'trainingTips',
];

export function formatPadbolAcademyPlayerKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_PLAYER_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_PLAYER_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_PLAYER_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — PLAYER (v${PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION})`,
    'Guía práctica para jugadores. Orientación formativa de Padbol Academy.',
    ...blocks,
  ].join('\n\n');
}

export function getPadbolAcademyPlayerSectionKeys() {
  return [...PADBOL_ACADEMY_PLAYER_SECTION_ORDER];
}
