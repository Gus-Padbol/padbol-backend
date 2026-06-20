import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CHIVI_REFERRAL_KNOWLEDGE_VERSION,
  CHIVI_REFERRAL_SECTIONS,
  SECTION_ORDER,
  formatChiviReferralKnowledgeForPrompt,
  getChiviReferralSectionKeys,
} from '../src/ai/knowledge/chiviReferralKnowledgeV1.js';
import { CHIVI_SYSTEM_PROMPT } from '../src/config/chiviContext.js';

describe('chiviReferralKnowledgeV1', () => {
  it('expone versión 1.0.0 y secciones esperadas', () => {
    assert.equal(CHIVI_REFERRAL_KNOWLEDGE_VERSION, '1.0.0');
    assert.equal(SECTION_ORDER.length, 7);
    assert.deepEqual(getChiviReferralSectionKeys(), SECTION_ORDER);
    assert.ok(CHIVI_REFERRAL_SECTIONS.officialCoachCertification);
    assert.ok(CHIVI_REFERRAL_SECTIONS.officialRefereeCertification);
    assert.ok(CHIVI_REFERRAL_SECTIONS.commercialPadbolProject);
    assert.ok(CHIVI_REFERRAL_SECTIONS.appSupport);
    assert.ok(CHIVI_REFERRAL_SECTIONS.rulesAndTechnicalQuestions);
    assert.ok(CHIVI_REFERRAL_SECTIONS.kidsAndSchools);
    assert.ok(CHIVI_REFERRAL_SECTIONS.tournamentsAndCompetition);
  });

  it('formatChiviReferralKnowledgeForPrompt incluye contenido de derivación esperado', () => {
    const text = formatChiviReferralKnowledgeForPrompt();
    assert.equal(typeof text, 'string');
    assert.notEqual(text, '');
    assert.match(text, /Padbol Academy/i);
    assert.match(text, /FIPA/i);
    assert.match(text, /soporte/i);
    assert.match(text, /no inventar/i);
    assert.match(text, /no reemplaza al árbitro oficial/i);
    assert.match(text, /collaborate-with-us/);
    assert.doesNotMatch(text, /Chivi certifica/i);
  });

  it('no conecta referral knowledge al prompt productivo de Chivi todavía', () => {
    const chiviContextSource = readFileSync('src/config/chiviContext.js', 'utf8');
    assert.doesNotMatch(chiviContextSource, /chiviReferralKnowledgeV1/);
    assert.doesNotMatch(CHIVI_SYSTEM_PROMPT, /CHIVI REFERRAL — DERIVACIONES OFICIALES/i);
  });
});
