import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADBOL_KNOWLEDGE_VERSION,
  PADBOL_OFFICIAL_LINKS,
  formatPadbolKnowledgeForPrompt,
  getPadbolKnowledgeSectionKeys,
} from '../src/ai/knowledge/padbolKnowledgeV1.js';
import { CHIVI_BEHAVIOR_RULES, CHIVI_SYSTEM_PROMPT } from '../src/config/chiviContext.js';

describe('padbolKnowledgeV1', () => {
  it('expone versión y secciones esperadas', () => {
    assert.equal(PADBOL_KNOWLEDGE_VERSION, '1.0.0');
    const keys = getPadbolKnowledgeSectionKeys();
    assert.ok(keys.includes('identity'));
    assert.ok(keys.includes('commercial'));
    assert.ok(keys.includes('padbolMatch'));
    assert.equal(keys.length, 21);
  });

  it('incluye contenido institucional clave', () => {
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /Carlos Gustavo Miguens/i);
    assert.match(text, /La Plata/i);
    assert.match(text, /2 vs 2/i);
    assert.match(text, /10 m x 6 m/i);
    assert.match(text, /FIPA/i);
    assert.match(text, /Copa América/i);
    assert.match(text, /Padbol Match/i);
  });

  it('incluye enlaces comerciales oficiales', () => {
    assert.equal(PADBOL_OFFICIAL_LINKS.collaborate, 'https://padbol.com/collaborate-with-us/');
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /collaborate-with-us/);
    assert.match(text, /No inventar precios/i);
  });
});

describe('chiviContext', () => {
  it('integra knowledge v1 en el system prompt', () => {
    assert.match(CHIVI_SYSTEM_PROMPT, /BASE DE CONOCIMIENTO PADBOL \(v1\.0\.0\)/);
    assert.match(CHIVI_SYSTEM_PROMPT, /Chivi/);
    assert.match(CHIVI_SYSTEM_PROMPT, /7 idiomas/i);
  });

  it('mantiene reglas de deportes reservables', () => {
    assert.match(CHIVI_BEHAVIOR_RULES, /Padbol, Pádel, Pickleball y Tenis/);
    assert.match(CHIVI_BEHAVIOR_RULES, /No modifiques reservas, pagos/i);
  });
});
