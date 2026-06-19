import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADBOL_KNOWLEDGE_VERSION,
  PADBOL_KNOWLEDGE_V1,
  PADBOL_KNOWLEDGE_V1_ID,
  PADBOL_OFFICIAL_LINKS,
  formatPadbolKnowledgeForPrompt,
  getPadbolKnowledgeSectionKeys,
} from '../src/ai/knowledge/padbolKnowledgeV1.js';
import { CHIVI_BEHAVIOR_RULES, CHIVI_SYSTEM_PROMPT } from '../src/config/chiviContext.js';

describe('padbolKnowledgeV1', () => {
  it('expone versión 1.1.0 y secciones esperadas', () => {
    assert.equal(PADBOL_KNOWLEDGE_VERSION, '1.1.0');
    assert.equal(PADBOL_KNOWLEDGE_V1_ID, 'padbol-knowledge-v1.1');
    const keys = getPadbolKnowledgeSectionKeys();
    assert.ok(keys.includes('identity'));
    assert.ok(keys.includes('commercial'));
    assert.ok(keys.includes('padbolMatch'));
    assert.equal(keys.length, 21);
  });

  it('incluye contenido institucional clave con redacción segura', () => {
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /surge en 2008 en La Plata/i);
    assert.match(text, /Gustavo Miguens/i);
    assert.match(text, /2 vs 2/i);
    assert.match(text, /10 m x 6 m/i);
    assert.match(text, /red central baja/i);
    assert.match(text, /FIPA/i);
    assert.match(text, /Copa América/i);
    assert.match(text, /Padbol Match/i);
    assert.match(text, /según disponibilidad de cada club/i);
  });

  it('excluye datos dudosos o no confirmados', () => {
    const text = PADBOL_KNOWLEDGE_V1;
    assert.doesNotMatch(text, /30\+|más de 30 países/i);
    assert.doesNotMatch(text, /Salvador Castiglione/i);
    assert.doesNotMatch(text, /Carlos Gustavo Miguens/i);
    assert.doesNotMatch(text, /2007-2008/i);
    assert.doesNotMatch(text, /Primera cancha instalada: 2010|primera cancha oficial se instaló en 2010/i);
    assert.doesNotMatch(text, /2,5 m|3,5 m/i);
    assert.doesNotMatch(text, /categorías masculinas/i);
    assert.doesNotMatch(text, /no hay red|sin red/i);
    assert.doesNotMatch(text, /Argentina, Brasil, México/i);
    assert.match(text, /comunidad en crecimiento en distintos países/i);
    assert.match(text, /A diferencia del vóley, la red de Padbol es baja/i);
  });

  it('incluye enlaces comerciales oficiales', () => {
    assert.equal(PADBOL_OFFICIAL_LINKS.collaborate, 'https://padbol.com/collaborate-with-us/');
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /collaborate-with-us/);
    assert.match(text, /No inventar precios/i);
  });
});

describe('chiviContext', () => {
  it('integra knowledge v1.1 en el system prompt', () => {
    assert.match(CHIVI_SYSTEM_PROMPT, /BASE DE CONOCIMIENTO PADBOL \(v1\.1\.0\)/);
    assert.match(CHIVI_SYSTEM_PROMPT, /Chivi/);
    assert.match(CHIVI_SYSTEM_PROMPT, /7 idiomas/i);
    assert.match(CHIVI_SYSTEM_PROMPT, /collaborate-with-us/i);
  });

  it('mantiene reglas de deportes reservables', () => {
    assert.match(CHIVI_BEHAVIOR_RULES, /Padbol, Pádel, Pickleball y Tenis/);
    assert.match(CHIVI_BEHAVIOR_RULES, /No modifiques reservas, pagos/i);
  });
});
