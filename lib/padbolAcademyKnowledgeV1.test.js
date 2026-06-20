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

describe('padbolAcademyKnowledgeV1', () => {
  it('importa módulos academy con versiones esperadas', () => {
    assert.equal(PADBOL_ACADEMY_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION, '1.1.0');
    assert.equal(PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION, '1.1.0');
  });

  it('formatPadbolAcademyKnowledgeForPrompt devuelve string (aggregate stub)', () => {
    assert.equal(typeof formatPadbolAcademyKnowledgeForPrompt(), 'string');
    assert.equal(formatPadbolAcademyKnowledgeForPrompt(), '');
    assert.equal(formatPadbolAcademyKnowledgeForPrompt({ modules: ['rulesTechnique'] }), '');
  });

  it('format por módulo vacío sigue vacío excepto rulesTechnique y player', () => {
    assert.equal(formatPadbolAcademyCoachKnowledgeForPrompt(), '');
    assert.equal(formatPadbolAcademyKidsKnowledgeForPrompt(), '');
    assert.notEqual(formatPadbolAcademyRulesTechniqueKnowledgeForPrompt(), '');
    assert.notEqual(formatPadbolAcademyPlayerKnowledgeForPrompt(), '');
  });

  it('player incluye contenido práctico esperado', () => {
    const text = formatPadbolAcademyPlayerKnowledgeForPrompt();
    assert.match(text, /primer toque/i);
    assert.match(text, /cristales/i);
    assert.match(text, /servicio/i);
    assert.match(text, /colocador/i);
    assert.match(text, /Guía práctica para jugadores/i);
    assert.doesNotMatch(text, /certifica/i);
  });

  it('rulesTechnique incluye contenido técnico básico esperado', () => {
    const text = formatPadbolAcademyRulesTechniqueKnowledgeForPrompt();
    assert.match(text, /servicio/i);
    assert.match(text, /cristales/i);
    assert.match(text, /primer toque/i);
    assert.match(text, /10 m x 6/i);
    assert.match(text, /2 vs 2/i);
    assert.match(text, /Conocimiento técnico básico de Padbol Academy/i);
    assert.doesNotMatch(text, /Chivi certifica entrenadores/i);
    assert.match(text, /no certifica entrenadores/i);
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
