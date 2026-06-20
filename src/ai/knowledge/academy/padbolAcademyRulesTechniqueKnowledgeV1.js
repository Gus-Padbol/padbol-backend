export const PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION = '1.0.0';

/** @type {Record<string, string>} */
export const PADBOL_ACADEMY_RULES_TECHNIQUE_SECTIONS = {};

export const PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER = [];

export function formatPadbolAcademyRulesTechniqueKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_RULES_TECHNIQUE_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — RULES & TECHNIQUE (v${PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION})`,
    ...blocks,
  ].join('\n\n');
}
