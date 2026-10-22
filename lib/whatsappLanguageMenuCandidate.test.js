import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsappLanguageMenu, renderLanguageMenu, SPANISH_MENU, MENU_TOPICS, SPANISH_SUBMENUS, ENGLISH_SUBMENUS } from './whatsappLanguageMenuCandidate.js';

test('el menú tiene siete opciones y español neutro', () => {
  const body = renderLanguageMenu(SPANISH_MENU);
  assert.equal(MENU_TOPICS.length, 7);
  assert.match(body, /¿Sobre qué quieres consultar\?/);
  assert.match(body, /\*7\.\* Otros — otro tipo de consulta/);
  assert.match(body, /^¡Hola! \*Bienvenido a Padbol\.\*/);
  assert.match(body, /español e inglés/);
  assert.throws(() => renderLanguageMenu({ ...SPANISH_MENU }), /NOT_REVIEWED/);
});
test('solo publica texto aprobado y no infiere idioma de país', async () => {
  let sent;
  const service = createWhatsappLanguageMenu({ env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ language: 'de' }) }) };
  } });
  assert.equal(await service.resolve('Guten Tag'), null);
  assert.equal(sent.store, false);
  assert.match(sent.instructions, /Do not infer language from country or phone/);
  assert.match(sent.instructions, /Do not translate/);
  assert.equal((await service.resolve('1')).language, 'es');
});
test('ambiguo, idiomas no revisados y errores ofrecen alternativa sin adivinar', async () => {
  const service = createWhatsappLanguageMenu({ env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async () => ({ok: true, json: async () => ({ output_text: JSON.stringify({ language: 'en' }) }) }) });
  assert.equal(await service.resolve('🙂'), null);
  assert.equal(await service.resolve('hello'), null);
  assert.equal(await createWhatsappLanguageMenu({ env: {} }).resolve('hello'), null);
  assert.equal(await createWhatsappLanguageMenu({env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async () => { throw Error('offline'); }}).resolve('hello'), null);
});


test('el menú inglés solo está disponible en el entorno QA previsto', async () => {
  const flags = { CRM_WHATSAPP_ENGLISH_MENU_QA_PREVIEW: 'true', BACKEND_RUNTIME_MODE: 'staging',
    STAGING_SUPABASE_PROJECT_REF: 'vxikhdulhuvghfqeutnp' };
  assert.equal((await createWhatsappLanguageMenu({ env: flags }).resolve('2')).language, 'en');
  assert.equal(await createWhatsappLanguageMenu({ env: { ...flags, BACKEND_RUNTIME_MODE: 'production' } }).resolve('2'), null);
  assert.equal(await createWhatsappLanguageMenu({ env: { ...flags, STAGING_SUPABASE_PROJECT_REF: 'other' } }).resolve('2'), null);
  assert.equal(await createWhatsappLanguageMenu({ env: { ...flags, CRM_WHATSAPP_ENGLISH_MENU_QA_PREVIEW: 'false' } }).resolve('2'), null);
});


test('Soporte es opción principal adicional para errores de cualquier producto', () => {
  assert.match(renderLanguageMenu(SPANISH_MENU), /\*6\.\* Soporte — reportar un error/);
  assert.match(SPANISH_SUBMENUS.soporte.prompt, /captura de pantalla/);
  assert.match(ENGLISH_SUBMENUS.soporte.prompt, /screenshot/);
});

test('los recorridos ofrecen información verificable y evitan enlaces para consultas generales', async () => {
  const { subtopicInformation } = await import('./whatsappLanguageMenuCandidate.js');
  for (const language of ['es', 'en']) {
    for (const [topic, choices] of Object.entries({ sede: [1, 2, 3], match: [1, 2, 3], next_generation: [1, 2], academy: [1, 2], fipa: [1, 2] })) {
      for (const choice of choices) assert.match(subtopicInformation(language, topic, choice), /https:\/\//);
    }
    for (const topic of ['sede','match','next_generation','academy','fipa']) assert.equal(subtopicInformation(language, topic, topic === 'sede' || topic === 'match' ? 4 : 3), null);
    assert.equal(subtopicInformation(language, 'soporte', 1), null);
    assert.equal(subtopicInformation(language, 'otros', 1), null);
  }
});


test('la propuesta inglesa cubre la representación y el alcance geográfico del español', async () => {
  const { ENGLISH_MENU, topicPrompt } = await import('./whatsappLanguageMenuCandidate.js');
  assert.match(renderLanguageMenu(ENGLISH_MENU), /become a representative/);
  assert.match(topicPrompt('en', 'sede', ENGLISH_SUBMENUS.sede), /city, region, or country/);
  for (const topic of MENU_TOPICS) {
    assert.equal(ENGLISH_SUBMENUS[topic].options.length, SPANISH_SUBMENUS[topic].options.length);
    assert.match(topicPrompt('en', topic, ENGLISH_SUBMENUS[topic]), /8\. Speak with an advisor/);
    assert.match(topicPrompt('en', topic, ENGLISH_SUBMENUS[topic]), /0\. Back to menu/);
  }
});
