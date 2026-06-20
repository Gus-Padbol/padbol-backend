import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADBOL_KNOWLEDGE_VERSION,
  PADBOL_KNOWLEDGE_V1,
  PADBOL_KNOWLEDGE_V1_ID,
  PADBOL_KNOWLEDGE_SECTIONS,
  PADBOL_OFFICIAL_LINKS,
  formatPadbolKnowledgeForPrompt,
  getPadbolKnowledgeSectionKeys,
} from '../src/ai/knowledge/padbolKnowledgeV1.js';
import { CHIVI_BEHAVIOR_RULES, CHIVI_SYSTEM_PROMPT } from '../src/config/chiviContext.js';

describe('padbolKnowledgeV1', () => {
  it('expone versión 1.2.1 y secciones esperadas', () => {
    assert.equal(PADBOL_KNOWLEDGE_VERSION, '1.2.1');
    assert.equal(PADBOL_KNOWLEDGE_V1_ID, 'padbol-knowledge-v1.2.1');
    const keys = getPadbolKnowledgeSectionKeys();
    assert.ok(keys.includes('identity'));
    assert.ok(keys.includes('commercial'));
    assert.ok(keys.includes('padbolMatch'));
    assert.ok(keys.includes('multideporte'));
    assert.ok(keys.includes('supportAi'));
    assert.ok(keys.includes('intentRouting'));
    assert.ok(keys.includes('coachAi'));
    assert.equal(keys.length, 25);
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
    assert.match(text, /cantidad de países indicada por la web oficial de Padbol/i);
    assert.match(text, /según la información oficial publicada en padbol\.com/i);
    assert.match(text, /A diferencia del vóley, la red de Padbol es baja/i);
  });

  it('incluye enlaces comerciales oficiales', () => {
    assert.equal(PADBOL_OFFICIAL_LINKS.collaborate, 'https://padbol.com/collaborate-with-us/');
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /collaborate-with-us/);
    assert.match(text, /No inventar precios/i);
  });

  it('incluye Support AI con límites de pagos y reservas', () => {
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /SUPPORT AI/i);
    assert.match(text, /Reservar cancha/i);
    assert.match(text, /Buscar partido/i);
    assert.match(text, /Crear partido/i);
    assert.match(text, /Rankings/i);
    assert.match(text, /Completar perfil/i);
    assert.match(text, /Pago pendiente/i);
    assert.match(text, /No confirmar pagos/i);
    assert.match(text, /No prometer devolución/i);
    assert.match(text, /No modificar reservas/i);
  });

  it('incluye Coach AI para Padbol, pádel, pickleball y tenis', () => {
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /COACH AI/i);
    assert.match(text, /Padbol \(2 vs 2\)/i);
    assert.match(text, /uso de paredes/i);
    assert.match(text, /Pádel:/i);
    assert.match(text, /bandeja\/víbora/i);
    assert.match(text, /Pickleball:/i);
    assert.match(text, /kitchen/i);
    assert.match(text, /Tenis:/i);
    assert.match(text, /No inventar estadísticas personales/i);
    assert.match(text, /No decir "vi tu partido"/i);
  });

  it('incluye mensaje multideporte', () => {
    const text = formatPadbolKnowledgeForPrompt();
    assert.match(text, /PADBOL MATCH MULTIDEPORTE/i);
    assert.match(text, /otros deportes habilitados por cada sede/i);
    assert.match(text, /Padbol es el deporte principal/i);
  });

  it('clasifica intención: coach vs comercial con ejemplos explícitos', () => {
    const routing = PADBOL_KNOWLEDGE_SECTIONS.intentRouting;
    const coach = PADBOL_KNOWLEDGE_SECTIONS.coachAi;
    const commercial = PADBOL_KNOWLEDGE_SECTIONS.commercial;

    assert.match(routing, /Dame consejos para mejorar en Padbol/i);
    assert.match(routing, /Coach AI/i);
    assert.match(routing, /Quiero abrir una sede de Padbol/i);
    assert.match(routing, /Comercial/i);
    assert.match(routing, /mejorar.*NUNCA es consulta comercial/i);

    assert.match(coach, /PROHIBIDO en respuestas Coach AI/i);
    assert.match(coach, /sin URL comercial/i);
    assert.match(routing, /sin collaborate-with-us/i);
    assert.match(coach, /Dame consejos para mejorar en Padbol/i);
    assert.match(coach, /comunicación constante con tu compañero/i);

    assert.match(commercial, /collaborate-with-us/i);
    assert.match(commercial, /NO aplicar a consultas deportivas/i);
  });
});

describe('chiviContext', () => {
  it('integra knowledge v1.2.1 y Padbol Academy en el system prompt', () => {
    assert.match(CHIVI_SYSTEM_PROMPT, /BASE DE CONOCIMIENTO PADBOL \(v1\.2\.1\)/);
    assert.match(CHIVI_SYSTEM_PROMPT, /BASE DE CONOCIMIENTO PADBOL ACADEMY \(v1\.0\.0\)/);
    assert.match(CHIVI_SYSTEM_PROMPT, /Chivi/);
    assert.match(CHIVI_SYSTEM_PROMPT, /7 idiomas/i);
    assert.match(CHIVI_SYSTEM_PROMPT, /collaborate-with-us/i);
    assert.match(CHIVI_SYSTEM_PROMPT, /no certifica/i);
    assert.doesNotMatch(CHIVI_SYSTEM_PROMPT, /Chivi certifica/i);
  });

  it('mantiene reglas Support AI, Coach AI y límites operativos', () => {
    assert.match(CHIVI_BEHAVIOR_RULES, /Support AI/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /Coach AI/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /multideporte/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /No confirmes pagos/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /No modifiques reservas, pagos/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /No inventes estadísticas personales/i);
  });

  it('prioriza Coach AI sobre comercial para consejos deportivos', () => {
    assert.match(CHIVI_BEHAVIOR_RULES, /CLASIFICACIÓN DE INTENCIÓN/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /Coach AI tiene prioridad sobre comercial/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /NUNCA son consultas comerciales/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /PROHIBIDO en Coach AI/i);
    assert.match(CHIVI_BEHAVIOR_RULES, /NO derivar a comercial si el usuario solo pide consejos deportivos/i);
  });
});
