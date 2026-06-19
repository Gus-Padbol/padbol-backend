import {
  CHIVI_GENERAL_MAX_TOKENS,
  CHIVI_GENERAL_PROMPT_ID,
  CHIVI_GENERAL_PROMPT_VERSION,
  CHIVI_GENERAL_SYSTEM_PROMPT,
} from './chiviGeneralV1.js';

const PROMPTS_BY_SKILL = {
  'chivi-general': {
    id: CHIVI_GENERAL_PROMPT_ID,
    version: CHIVI_GENERAL_PROMPT_VERSION,
    system: CHIVI_GENERAL_SYSTEM_PROMPT,
    maxTokens: CHIVI_GENERAL_MAX_TOKENS,
  },
};

export function resolvePromptForSkill(skill) {
  const prompt = PROMPTS_BY_SKILL[String(skill ?? '').trim().toLowerCase()];
  if (!prompt) {
    const err = new Error(`Prompt no configurado para skill: ${skill}`);
    err.status = 400;
    err.code = 'AI_SKILL_NOT_ALLOWED';
    throw err;
  }
  return prompt;
}

export function formatPromptVersion(prompt) {
  return `${prompt.id}@${prompt.version}`;
}
