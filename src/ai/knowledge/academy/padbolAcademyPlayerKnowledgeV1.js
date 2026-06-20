export const PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION = '1.0.0';

/** @type {Record<string, string>} */
export const PADBOL_ACADEMY_PLAYER_SECTIONS = {};

export const PADBOL_ACADEMY_PLAYER_SECTION_ORDER = [];

export function formatPadbolAcademyPlayerKnowledgeForPrompt() {
  if (PADBOL_ACADEMY_PLAYER_SECTION_ORDER.length === 0) {
    return '';
  }

  const blocks = PADBOL_ACADEMY_PLAYER_SECTION_ORDER.map(
    (key) => PADBOL_ACADEMY_PLAYER_SECTIONS[key],
  );

  return [
    `PADBOL ACADEMY — PLAYER (v${PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION})`,
    ...blocks,
  ].join('\n\n');
}
