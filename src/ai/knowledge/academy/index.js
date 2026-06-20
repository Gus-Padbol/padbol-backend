export {
  PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_COACH_SECTIONS,
  PADBOL_ACADEMY_COACH_SECTION_ORDER,
  formatPadbolAcademyCoachKnowledgeForPrompt,
} from './padbolAcademyCoachKnowledgeV1.js';

export {
  PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_PLAYER_SECTIONS,
  PADBOL_ACADEMY_PLAYER_SECTION_ORDER,
  formatPadbolAcademyPlayerKnowledgeForPrompt,
} from './padbolAcademyPlayerKnowledgeV1.js';

export {
  PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_KIDS_SECTIONS,
  PADBOL_ACADEMY_KIDS_SECTION_ORDER,
  formatPadbolAcademyKidsKnowledgeForPrompt,
} from './padbolAcademyKidsKnowledgeV1.js';

export {
  PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_RULES_TECHNIQUE_SECTIONS,
  PADBOL_ACADEMY_RULES_TECHNIQUE_SECTION_ORDER,
  formatPadbolAcademyRulesTechniqueKnowledgeForPrompt,
} from './padbolAcademyRulesTechniqueKnowledgeV1.js';

export const PADBOL_ACADEMY_KNOWLEDGE_VERSION = '1.0.0';

/**
 * Composes Academy knowledge for Chivi. Not wired to production yet.
 * @param {{ modules?: ('coach'|'player'|'kids'|'rulesTechnique')[] }} [options]
 * @returns {string}
 */
export function formatPadbolAcademyKnowledgeForPrompt(_options = {}) {
  // Stub: return empty until sections are populated and integration is enabled.
  return '';
}
