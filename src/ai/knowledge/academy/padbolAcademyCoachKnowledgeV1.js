export const PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION = '1.0.0';

/** @type {Record<string, string>} */
export const PADBOL_ACADEMY_COACH_SECTIONS = {};

export const PADBOL_ACADEMY_COACH_SECTION_ORDER = [];

export function formatPadbolAcademyCoachKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_COACH_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_COACH_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_COACH_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — COACH (v${PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION})`,
    ...blocks,
  ].join('\n\n');
}
