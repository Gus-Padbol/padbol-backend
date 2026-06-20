export const PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION = '1.1.0';

/**
 * Conocimiento técnico básico Padbol Academy (reglas y técnica de juego).
 * Resumen formativo; no sustituye el manual completo ni certificaciones oficiales.
 */
export const PADBOL_ACADEMY_RULES_TECHNIQUE_SECTIONS = {
  courtAndBasicGame: `PISTA Y JUEGO BÁSICO
Pista oficial: 10 m x 6 m, con red central baja que divide el campo.
Los cristales (paredes de vidrio) son parte activa del juego, no solo límites.
Modalidad: 2 vs 2 (cuatro jugadores).
Puntuación: sistema tipo tenis/pádel según reglamento del torneo o partido.
Regla de toques: máximo tres toques por equipo para devolver la pelota al campo rival.
Obligación de combinar con el compañero antes de pasar al rival, salvo excepciones reglamentarias oficiales.
Chivi no certifica entrenadores; para reglamento fino, derivar a FIPA o material oficial Padbol Academy.`,

  serviceBasics: `FUNDAMENTOS DEL SERVICIO
Servicio cruzado hacia el cuadrante diagonal del rival.
Bote previo obligatorio antes del impacto, según reglamento de saque.
Respetar zona de servicio y zona de recepción oficiales.
Variantes básicas de saque:
- Servicio directo al cuadrante rival.
- Servicio con cristal lateral (usar el vidrio para entrar al juego).
- Servicio a doble cristal (pelota que toca dos cristales según reglamento).
- Servicio a puerta (orientado hacia la puerta/zona de recepción rival).
Consejos de ejecución:
- Impactar en el punto alto del bote.
- Control con interior del pie para mayor precisión.
- Cuando ya domina la base, variar superficie de contacto para generar efecto y sorpresa.`,

  positioningBasics: `UBICACIÓN EN PISTA
Ubicación ideal según perfil:
- Jugador diestro suele rendir mejor en la banda izquierda; zurdo, en la derecha.
- Si ambos son diestros, probar posiciones hasta diferenciar roles de colocador y rematador.
Recepción de saque:
- Colocarse cerca de puerta o fondo según pierna dominante y tipo de saque rival.
- Ajustar distancia a la red/puerta para tener tiempo de primer toque y lectura del cristal.`,

  glassUsage: `USO DE LOS CRISTALES
Tres usos principales: defensivo, combinativo y ofensivo.
Defensivo: ganar tiempo, recuperar posición y prolongar el punto con control.
Combinativo: construir jugada con compañero usando paredes para cambiar ángulo.
Ofensivo: buscar salidas incómodas para el rival con ángulos sobre cristal.
En pases combinativos, evitar la zona media-baja del cristal (rebote menos predecible).
Preferir la zona más alta del cristal para pases más cómodos y controlados.
Los cristales son recurso de continuidad, defensa y construcción del punto.`,

  firstSecondThirdTouch: `PRIMER, SEGUNDO Y TERCER TOQUE
Estructura típica del equipo (similar a recepción → colocación → remate):
Primer toque: evitar devolver al punto rival; iniciar salida de presión o ataque.
Segundo toque: colocación — preparar al compañero o abrir ángulo hacia cristal o rival.
Tercer toque: finalización o remate cuando la jugada lo permite.
No forzar remate en el segundo toque si aún no hay ventaja; construir con paciencia.`,

  finishingBasics: `FINALIZACIÓN BÁSICA
Opciones de cierre según situación:
- Cabeza: definición aérea o de cabeza cuando la pelota queda alta y controlada.
- Volea: impacto en vuelo para cerrar antes del segundo bote.
- Chilena: recurso avanzado; solo mencionar como opción avanzada, sin enseñar ejecución de riesgo sin supervisión.
- Remates generales: buscar precisión antes que potencia en nivel básico.
Chivi ofrece orientación general; no promete dominar técnica avanzada sin práctica guiada en pista.`,

  defensiveBasics: `DEFENSA BÁSICA
Buena defensa habilita el contraataque; no solo “salvar” el punto.
Posicionamiento sincronizado con el compañero (diagonal, cobertura de huecos).
Leer al rival antes de su ataque: preparación de cuerpo, orientación de pierna, tipo de saque o tercer toque.
Ante voleas o chilenas rivales: bloqueo controlado y cobertura activa del compañero.
Mantener calma tras defender cristal; el siguiente toque puede ser transición a ataque.`,
};

export const PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER = [
  'courtAndBasicGame',
  'serviceBasics',
  'positioningBasics',
  'glassUsage',
  'firstSecondThirdTouch',
  'finishingBasics',
  'defensiveBasics',
];

export function formatPadbolAcademyRulesTechniqueKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_RULES_TECHNIQUE_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — RULES & TECHNIQUE (v${PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION})`,
    'Conocimiento técnico básico de Padbol Academy. Orientación formativa; no certifica entrenadores ni árbitros.',
    ...blocks,
  ].join('\n\n');
}

export function getPadbolAcademyRulesTechniqueSectionKeys() {
  return [...PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER];
}
