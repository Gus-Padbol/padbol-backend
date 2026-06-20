import { formatPadbolAcademyCoachKnowledgeForPrompt } from './padbolAcademyCoachKnowledgeV1.js';
import { formatPadbolAcademyKidsKnowledgeForPrompt } from './padbolAcademyKidsKnowledgeV1.js';
import { formatPadbolAcademyPlayerKnowledgeForPrompt } from './padbolAcademyPlayerKnowledgeV1.js';
import { formatPadbolAcademyRulesTechniqueKnowledgeForPrompt } from './padbolAcademyRulesTechniqueKnowledgeV1.js';

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

const DEFAULT_MODULE_ORDER = ['rulesTechnique', 'player', 'coach', 'kids'];

const MODULE_FORMATTERS = {
  rulesTechnique: formatPadbolAcademyRulesTechniqueKnowledgeForPrompt,
  player: formatPadbolAcademyPlayerKnowledgeForPrompt,
  coach: formatPadbolAcademyCoachKnowledgeForPrompt,
  kids: formatPadbolAcademyKidsKnowledgeForPrompt,
};

/**
 * Composes Padbol Academy knowledge for Chivi (complemento de padbolKnowledgeV1).
 * @param {{ modules?: ('coach'|'player'|'kids'|'rulesTechnique')[] }} [options]
 * @returns {string}
 */
export function formatPadbolAcademyKnowledgeForPrompt(options = {}) {
  const modules = options.modules ?? DEFAULT_MODULE_ORDER;
  const moduleBlocks = modules
    .filter((name) => MODULE_FORMATTERS[name])
    .map((name) => MODULE_FORMATTERS[name]());

  const header = `=== BASE DE CONOCIMIENTO PADBOL ACADEMY (v${PADBOL_ACADEMY_KNOWLEDGE_VERSION}) ===
Chivi orienta, recomienda y educa con base en Padbol Academy.
No certifica entrenadores ni árbitros; la certificación oficial corresponde a Padbol Academy / FIPA / canales oficiales (www.padbol.com).
Si el usuario pregunta reiteradamente por enseñar, dar clases, entrenar niños, ser coach o certificarse:
- Sugerir el camino oficial de Padbol Academy y FIPA.
- No inventar precios, fechas ni requisitos.
- Derivar a canales oficiales para programas formativos e instructor/coach certificado.
Contenido formativo resumido; consultar reglamento y programas oficiales para detalle.`;

  return [header, ...moduleBlocks].filter(Boolean).join('\n\n');
}
