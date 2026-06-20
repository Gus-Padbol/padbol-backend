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
    assert.equal(PADBOL_ACADEMY_COACH_KNOWLEDGE_VERSION, '1.1.0');
    assert.equal(PADBOL_ACADEMY_PLAYER_KNOWLEDGE_VERSION, '1.1.0');
    assert.equal(PADBOL_ACADEMY_KIDS_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(PADBOL_ACADEMY_RULES_TECHNIQUE_KNOWLEDGE_VERSION, '1.2.0');
  });

  it('formatPadbolAcademyKnowledgeForPrompt devuelve string (aggregate stub)', () => {
    assert.equal(typeof formatPadbolAcademyKnowledgeForPrompt(), 'string');
    assert.equal(formatPadbolAcademyKnowledgeForPrompt(), '');
    assert.equal(formatPadbolAcademyKnowledgeForPrompt({ modules: ['rulesTechnique'] }), '');
  });

  it('format por módulo vacío sigue vacío excepto coach, player y rulesTechnique', () => {
    assert.equal(formatPadbolAcademyKidsKnowledgeForPrompt(), '');
    assert.notEqual(formatPadbolAcademyCoachKnowledgeForPrompt(), '');
    assert.notEqual(formatPadbolAcademyRulesTechniqueKnowledgeForPrompt(), '');
    assert.notEqual(formatPadbolAcademyPlayerKnowledgeForPrompt(), '');
  });

  it('coach incluye contenido formativo esperado', () => {
    const text = formatPadbolAcademyCoachKnowledgeForPrompt();
    assert.match(text, /entrenador/i);
    assert.match(text, /comunicador/i);
    assert.match(text, /embajador/i);
    assert.match(text, /metodología/i);
    assert.match(text, /Guía formativa para entrenadores/i);
    assert.doesNotMatch(text, /Chivi certifica/i);
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

  it('rulesTechnique incluye reglas oficiales resumidas', () => {
    const text = formatPadbolAcademyRulesTechniqueKnowledgeForPrompt();
    assert.match(text, /10 m x 6 m/i);
    assert.match(text, /zona de ataque/i);
    assert.match(text, /segundo servicio/i);
    assert.match(text, /15, 30, 40/i);
    assert.match(text, /brazos/i);
    assert.match(text, /servicio/i);
    assert.match(text, /cristales/i);
    assert.match(text, /2 vs 2/i);
    assert.match(text, /Padbol Official Game Rules/i);
    assert.match(text, /no reemplaza al árbitro oficial/i);
    assert.doesNotMatch(text, /Chivi certifica/i);
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
