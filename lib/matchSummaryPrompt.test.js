import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_ALLOWED_SKILLS } from '../src/ai/constants.js';
import { validateAiChatRequest } from '../src/ai/context/allowlist.js';
import {
  MATCH_SUMMARY_PROMPT_VERSION,
  MATCH_SUMMARY_SYSTEM_PROMPT,
} from '../src/ai/prompts/matchSummaryV1.js';
import {
  formatPromptVersion,
  resolvePromptForSkill,
} from '../src/ai/prompts/registry.js';

describe('matchSummaryPrompt', () => {
  it('registry resuelve match-summary', () => {
    const prompt = resolvePromptForSkill('match-summary');

    assert.equal(prompt.id, 'match-summary');
    assert.equal(prompt.version, '1.0.0');
    assert.equal(prompt.system, MATCH_SUMMARY_SYSTEM_PROMPT);
    assert.equal(formatPromptVersion(prompt), 'match-summary@1.0.0');
    assert.equal(MATCH_SUMMARY_PROMPT_VERSION, 'match-summary@1.0.0');
  });

  it('prompt incluye regla no inventar', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /no inventar/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /SOLO datos presentes/i);
  });

  it('prompt exige JSON válido de salida', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /JSON válido/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /title/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /summary/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /highlights/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /disclaimers/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /source_fields_used/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /sin markdown/i);
  });

  it('prompt prohíbe MVP si no está en payload', () => {
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /No mencionar MVP/i);
    assert.match(MATCH_SUMMARY_SYSTEM_PROMPT, /salvo que exista explícitamente en el payload/i);
  });

  it('skill match-summary está permitida', () => {
    assert.ok(AI_ALLOWED_SKILLS.has('match-summary'));

    const parsed = validateAiChatRequest({
      skill: 'match-summary',
      message: 'Generar resumen',
    });

    assert.equal(parsed.skill, 'match-summary');
  });
});
