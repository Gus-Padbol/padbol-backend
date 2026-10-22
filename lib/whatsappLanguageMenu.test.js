import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsappLanguageMenu, renderLanguageMenu, SPANISH_MENU, MENU_TOPICS, SPANISH_SUBMENUS, ENGLISH_SUBMENUS } from './whatsappLanguageMenu.js';

test('el menú tiene siete opciones y español neutro', () => {
  const body = renderLanguageMenu(SPANISH_MENU);
  assert.equal(MENU_TOPICS.length, 7);
  assert.match(body, /¿Sobre qué quieres consultar\?/);
  assert.match(body, /7\. Otros — otro tipo de consulta/);
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
  assert.match(renderLanguageMenu(SPANISH_MENU), /6\. Soporte — reportar un error/);
  assert.match(SPANISH_SUBMENUS.soporte.prompt, /qué error.*qué producto/);
  assert.match(ENGLISH_SUBMENUS.soporte.prompt, /issue.*product/);
});
