export const PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION = '1.1.0';

/**
 * Conocimiento Padbol Academy para entrenadores, monitores e instructores.
 * Orientación formativa; no sustituye programas oficiales de certificación.
 */
export const PADBOL_ACADEMY_COACH_SECTIONS = {
  coachRole: `ROL DEL ENTRENADOR
El entrenador es líder del crecimiento del Padbol en su entorno.
Formador de jugadores, embajador del deporte y promotor en clubes, escuelas, torneos y comunidad.
Impulsa valores del juego, participación y desarrollo sostenible del ecosistema Padbol.`,

  idealCoachProfile: `PERFIL IDEAL DEL ENTRENADOR
Técnico: domina fundamentos reglamentarios y progresiones de enseñanza.
Comunicador: explica con claridad y escucha al grupo.
Embajador: representa Padbol con identidad y respeto institucional.
Liderazgo: organiza, motiva y mantiene estándares en la sesión.
Empatía: adapta el mensaje a distintos niveles, edades y ritmos de aprendizaje.
Conducta profesional: puntualidad, ejemplo en pista y trato respetuoso.`,

  teachingMethodology: `METODOLOGÍA DE ENSEÑANZA
Explicar de simple a complejo: una idea por vez, luego encadenar conceptos.
Adaptar al nivel del jugador: iniciación, adaptación y progresión intermedia.
Corregir errores concretos: señalar qué, cómo y por qué, sin saturar.
Progresar con secuencia: control → combinación → situación de juego → decisión táctica.
Combinar técnica, táctica y valores: fair play, trabajo en equipo y respeto al rival.`,

  sessionStructure: `ESTRUCTURA DE SESIÓN
Entrada en calor: movilidad, coordinación y contacto progresivo con la pelota.
Técnica básica: servicio, recepción, pase, uso de cristales según objetivo del día.
Ejercicios con compañero: 2 vs 2 reducido o situaciones guiadas.
Situaciones reales de juego: partidos cortos con reglas completas o variantes acordadas.
Cierre con feedback: repaso breve, reconocimiento y una meta para la próxima sesión.`,

  coachCommunication: `COMUNICACIÓN DEL ENTRENADOR
Claridad: instrucciones cortas y demostración cuando hace falta.
Motivación: reforzar esfuerzo y progreso, no solo el resultado.
Corrección positiva: corregir el error sin desmotivar; proponer alternativa.
Seguridad: vigilar espacio, intensidad y técnica de riesgo (p. ej. chilena avanzada).
Respeto e inclusión: ambiente donde todos participen según su nivel.`,

  developmentPath: `CAMINO DE DESARROLLO
Formar jugadores con base técnica y comprensión del juego en equipo.
Organizar entrenamientos regulares con objetivos medibles por etapa.
Generar comunidad: partidos abiertos, torneos locales y vínculo club–jugador.
Preparar jugadores para torneos: reglamento, presión de partido y roles en pista.
Proyectar al entrenador como referente formativo, no solo resultadista.`,

  limitsAndCertification: `LÍMITES Y CERTIFICACIÓN
Chivi puede orientar sobre metodología, contenidos y buenas prácticas de entrenamiento.
Chivi no otorga certificaciones de entrenador, instructor ni árbitro.
La certificación formal corresponde a Padbol Academy, FIPA y canales oficiales (www.padbol.com).
No inventar requisitos comerciales, precios ni plazos de certificación.`,
};

export const PADBOL_ACADEMY_COACH_SECTION_ORDER = [
  'coachRole',
  'idealCoachProfile',
  'teachingMethodology',
  'sessionStructure',
  'coachCommunication',
  'developmentPath',
  'limitsAndCertification',
];

export function formatPadbolAcademyCoachKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_COACH_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_COACH_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_COACH_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — COACH (v${PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION})`,
    'Guía formativa para entrenadores, monitores e instructores de Padbol Academy.',
    ...blocks,
  ].join('\n\n');
}

export function getPadbolAcademyCoachSectionKeys() {
  return [...PADBOL_ACADEMY_COACH_SECTION_ORDER];
}
