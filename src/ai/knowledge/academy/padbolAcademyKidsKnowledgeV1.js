export const PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION = '1.2.0';

/**
 * Conocimiento Padbol Academy para formación de niños.
 * Orientación formativa, segura y progresiva; no promete rendimiento ni resultados.
 */
export const PADBOL_ACADEMY_KIDS_SECTIONS = {
  kidsPurpose: `PROPÓSITO CON NIÑOS
Iniciar a niños y niñas en Padbol de forma segura, divertida y progresiva.
Priorizar coordinación, juego, confianza y hábitos deportivos saludables.
El objetivo es que disfruten el deporte y aprendan en equipo, no competir a toda costa.`,

  teachingPrinciples: `PRINCIPIOS DE ENSEÑANZA
Enseñanza simple: pocas consignas por ejercicio.
Ejercicios cortos con cambios frecuentes para mantener atención.
Lenguaje claro y adaptado al grupo.
Progresión por nivel del grupo, sin saltos bruscos.
Feedback positivo: reconocer el esfuerzo y la mejora.
Evitar sobreexigencia; respetar el ritmo de cada participante.`,

  basicMotorSkills: `HABILIDADES MOTRICES BÁSICAS
Coordinación ojo-pie y ojo-pelota en contextos lúdicos.
Equilibrio y base de apoyo estable.
Orientación espacial en pista (compañero, red, cristales).
Control corporal: frenar, girar y cambiar ritmo con seguridad.
Reacción y movilidad en desplazamientos cortos y controlados.`,

  technicalIntroduction: `INTRODUCCIÓN TÉCNICA
Contacto inicial con balón oficial o adaptado según programa de la sede.
Control con interior del pie en situaciones guiadas.
Pase simple al compañero a corta distancia.
Recepción básica: detener u orientar sin presión de rival fuerte.
Uso inicial de cristales de forma segura, con distancia y supervisión.
Remates solo como juego progresivo y opcional, sin exigencia ni competencia forzada.`,

  gameBasedLearning: `APRENDIZAJE BASADO EN EL JUEGO
Juegos por parejas y equipos reducidos.
Desafíos simples con reglas claras (p. ej. toques máximos, zonas acotadas).
Mini ejercicios con objetivos concretos y celebración del intento.
Cooperación antes que rivalidad excesiva.
Rotación de roles para que todos participen.
Aprender mediante diversión: el juego es el motor del entrenamiento.`,

  safetyAndEnvironment: `SEGURIDAD Y ENTORNO
Cuidar distancias entre grupos y con cristales.
Controlar intensidad: pausas, hidratación y ritmo acorde al grupo.
Evitar acciones acrobáticas forzadas (p. ej. chilenas) en etapas iniciales.
Adaptar ejercicios a edad y nivel del grupo, sin sobreentrenamiento.
Ambiente inclusivo, respetuoso y libre de presión por resultados.`,

  coachRoleWithKids: `ROL DEL ENTRENADOR CON NIÑOS
Guía que estructura la sesión con paciencia y ejemplo.
Motivador que celebra participación y actitud, no solo acierto técnico.
Generador de confianza: cada niño debe sentirse incluido.
Promotor de valores: respeto, compañerismo y fair play.
Comunicación clara con familias cuando corresponda (logística, actitud, seguridad).`,

  officialCertificationPath: `CERTIFICACIÓN Y CAMINO OFICIAL
Chivi puede orientar con ideas y conceptos básicos de formación con niños.
Chivi no otorga certificaciones de entrenador ni árbitro.
Si el usuario pregunta reiteradamente por enseñar, dar clases, metodología, entrenar niños o ser coach:
- Sugerir el camino oficial de Padbol Academy y FIPA (www.padbol.com).
- No inventar precios, fechas, requisitos ni plazos de certificación.
- Derivar a canales oficiales para programas formativos e instructor/coach certificado.`,
};

export const PADBOL_ACADEMY_KIDS_SECTION_ORDER = [
  'kidsPurpose',
  'teachingPrinciples',
  'basicMotorSkills',
  'technicalIntroduction',
  'gameBasedLearning',
  'safetyAndEnvironment',
  'coachRoleWithKids',
  'officialCertificationPath',
];

export function formatPadbolAcademyKidsKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_KIDS_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_KIDS_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_KIDS_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — KIDS (v${PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION})`,
    'Formación de niños en Padbol Academy: enfoque seguro, formativo y progresivo.',
    ...blocks,
  ].join('\n\n');
}

export function getPadbolAcademyKidsSectionKeys() {
  return [...PADBOL_ACADEMY_KIDS_SECTION_ORDER];
}
