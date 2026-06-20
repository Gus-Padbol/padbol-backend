export const PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION = '1.0.0';

/** @type {Record<string, string>} */
export const PADBOL_ACADEMY_KIDS_SECTIONS = {};

export const PADBOL_ACADEMY_KIDS_SECTION_ORDER = [];

export function formatPadbolAcademyKidsKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_KIDS_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_KIDS_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_KIDS_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — KIDS (v${PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION})`,
    ...blocks,
  ].join('\n\n');
}
