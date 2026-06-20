import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION,
  PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION,
  formatPadbolAcademyCoachKnowledgeForPrompt,
  formatPadbolAcademyKidsKnowledgeForPrompt,
  formatPadbolAcademyKnowledgeForPrompt,
  formatPadbolAcademyPlayerKnowledgeForPrompt,
  formatPadbolAcademyRulesTechniqueKnowledgeForPrompt,
} from '../src/ai/knowledge/academy/index.js';
import { CHIVI_SYSTEM_PROMPT } from '../src/config/chiviContext.js';

describe('padbolAcademyKnowledgeV1 stubs', () => {
  it('importa módulos academy con versiones 1.0.0', () => {
    assert.equal(PADBOL_ACADEMY_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION, '1.0.0');
  });

  it('formatPadbolAcademyKnowledgeForPrompt devuelve string vacío (stub)', () => {
    assert.equal(typeof formatPadbolAcademyKnowledgeForPrompt(), 'string');
    assert.equal(formatPadbolAcademyKnowledgeForPrompt(), '');
    assert.equal(formatPadbolAcademyKnowledgeForPrompt({ modules: ['coach', 'player'] }), '');
  });

  it('format por módulo devuelve string vacío sin secciones', () => {
    assert.equal(formatPadbolAcademyCoachKnowledgeForPrompt(), '');
    assert.equal(formatPadbolAcademyPlayerKnowledgeForPrompt(), '');
    assert.equal(formatPadbolAcademyKidsKnowledgeForPrompt(), '');
    assert.equal(formatPadbolAcademyRulesTechniqueKnowledgeForPrompt(), '');
  });

  it('no conecta academy al prompt productivo de Chivi todavía', () => {
    const chiviContextSource = readFileSync('src/config/chiviContext.js', 'utf8');
    assert.doesNotMatch(chiviContextSource, /knowledge\/academy/);
    assert.doesNotMatch(CHIVI_SYSTEM_PROMPT, /PADBOL ACADEMY — COACH/i);
    assert.doesNotMatch(CHIVI_SYSTEM_PROMPT, /PADBOL ACADEMY — PLAYER/i);
    assert.doesNotMatch(CHIVI_SYSTEM_PROMPT, /PADBOL ACADEMY — KIDS/i);
    assert.doesNotMatch(CHIVI_SYSTEM_PROMPT, /PADBOL ACADEMY — RULES & TECHNIQUE/i);
  });
});
