export const PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION = '1.2.0';

/**
 * Reglas y técnica Padbol Academy — resumen basado en Padbol Official Game Rules.
 * Orientación formativa; Chivi orienta, no reemplaza al árbitro oficial.
 */
export const PADBOL_ACADEMY_RULES_TECHNIQUE_SECTIONS = {
  courtAndBasicGame: `PISTA Y JUEGO BÁSICO
Cancha oficial: 10 m x 6 m.
Red central de 100 cm de altura según reglamento oficial.
Paredes/cristales y malla metálica forman parte de las instalaciones de juego.
Puertas laterales de acceso en la pista.
Zonas reglamentarias: servicio, recepción, zona roja/ataque y exterior.
Modalidad: 2 vs 2 (cuatro jugadores).
Pelota oficial: color blanco o amarillo; peso aprox. 380-400 g; presión 7-8 libras.`,

  serviceBasics: `SERVICIO (REGLAMENTO OFICIAL)
El servidor debe estar detrás de la línea de servicio.
Inicio desde el lado derecho; alternancia derecha/izquierda según reglamento.
Saque cruzado hacia el área de recepción válida del rival.
Bote previo obligatorio dentro de la zona de servicio antes del impacto.
Servicio directo al cuadrante rival o servicio con rebote en cristales (según reglamento).
Malla metálica en el saque: solo válida si la pelota rebotó antes en cristal.
Segundo servicio si el primero es falta.
Let si la pelota toca red/cinta y entra correctamente en el cuadrante de recepción.
Consejo técnico: impactar en el punto alto del bote; control con interior del pie.`,

  ballInPlayAndTouches: `PELOTA EN JUEGO Y TOQUES
La pelota entra en juego desde el servicio válido.
Entre compañeros: mínimo dos toques y máximo tres antes de devolver al campo rival.
Tras el tercer toque del equipo, la pelota debe enviarse al campo adversario.
Se puede usar pared/cristal para devolver si cumple el reglamento.
Brazos, antebrazos y manos no están permitidos para jugar la pelota.`,

  volleyAndAttackZone: `VOLEA Y ZONA DE ATAQUE
Tras el saque, el receptor no puede volear la pelota de recepción.
La volea está permitida después, en la zona roja/ataque.
Zona roja/ataque: 1 m a cada lado de la red (según marcado oficial).
Para volear válidamente, debe cumplirse el contacto con la zona de ataque según la regla oficial (consultar reglamento completo en duda).`,

  scoringAndMatchFormat: `PUNTUACIÓN Y FORMATO DE PARTIDO
Puntuación por juego: 15, 30, 40 y juego.
Ventaja en caso de iguales (40-40).
Set a 6 juegos con diferencia de 2.
Tie-break o sudden death cuando corresponda según formato del torneo o partido.
Partidos al mejor de 3 sets, con opción de mejor de 5 según competencia.`,

  lostPointAndFaults: `PÉRDIDA DE PUNTO Y FALTAS (RESUMEN)
Pierde el punto quien:
- Deja que la pelota bote en su propio campo tras un toque válido del rival.
- No juega antes del segundo bote en su campo cuando debía hacerlo.
- Toca la pelota con brazos, antebrazos o manos.
- Toca la red o elementos no permitidos según la situación reglamentaria.
- Volea fuera de la zona permitida o antes de tiempo (p. ej. recepción de saque).
- Invade o salta la red durante el punto.
Chivi resume reglas; ante disputa, prevalece el árbitro oficial.`,

  positioningBasics: `UBICACIÓN EN PISTA (TÉCNICA)
Jugador diestro suele rendir mejor en banda izquierda; zurdo, en derecha.
Si ambos son diestros, probar roles de colocador y rematador.
Recepción cerca de puerta o fondo según pierna dominante y tipo de saque rival.`,

  glassUsage: `USO DE CRISTALES (TÉCNICA)
Uso defensivo, combinativo y ofensivo según situación.
En pases combinativos, evitar zona media-baja del cristal; preferir zona alta.
Los cristales permiten continuidad y construcción cuando el reglamento lo autoriza.`,

  finishingBasics: `FINALIZACIÓN (TÉCNICA BÁSICA)
Cabeza, volea en zona de ataque y remates con preción antes que potencia.
Chilena: recurso avanzado; solo con supervisión en entrenamiento.`,

  defensiveBasics: `DEFENSA (TÉCNICA BÁSICA)
Posicionamiento sincronizado con compañero; lectura del rival.
Bloqueo y cobertura ante voleas o remates rivales dentro de reglas.`,
};

export const PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER = [
  'courtAndBasicGame',
  'serviceBasics',
  'ballInPlayAndTouches',
  'volleyAndAttackZone',
  'scoringAndMatchFormat',
  'lostPointAndFaults',
  'positioningBasics',
  'glassUsage',
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
    'Resumen basado en Padbol Official Game Rules. Chivi orienta; no reemplaza al árbitro oficial ni otorga certificaciones.',
    ...blocks,
  ].join('\n\n');
}

export function getPadbolAcademyRulesTechniqueSectionKeys() {
  return [...PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER];
}
