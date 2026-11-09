import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewHelpCorpus, HELP_MODULE_ROLE_CEILINGS } from '../scripts/check-admin-help-corpus.mjs';
const copy = { title: 'Synthetic title', requirements: ['Valid session'], steps: ['Synthetic step'], limit: 'Source-only fixture, not runtime evidence' };
const article = module => ({ id: module, module, slug: 'synthetic-guide', allowedRoles: [...HELP_MODULE_ROLE_CEILINGS[module]], status: 'reviewed', verification: 'source-reviewed', sourceVersion: { frontend: 'fixture', backend: 'fixture' }, sourceRefs: ['fixture'], translations: { es: copy, en: copy, pt: copy } });
test('review accepts all twelve module role ceilings with complete synthetic translations', () => assert.deepEqual(reviewHelpCorpus(Object.keys(HELP_MODULE_ROLE_CEILINGS).map(article)), []));
test('operational modules reject chain/national role expansion', () => {
  for (const module of ['sedes','reservas','validaciones','torneos','marcador','jugadores','membresias']) for (const role of ['admin_cadena','admin_nacional']) assert.ok(reviewHelpCorpus([{ ...article(module), allowedRoles: ['super_admin', role] }]).some(e => e.includes('allowedRoles')));
});
test('support/configuration reject non-super roles, missing locale and unreviewed wrapper fail', () => {
  for (const module of ['soporte','configuracion']) assert.ok(reviewHelpCorpus([{ ...article(module), allowedRoles: ['admin_club'] }]).length);
  assert.ok(reviewHelpCorpus({runtimeEligible:false,articles:[article('administracion')]}).length);
  assert.ok(reviewHelpCorpus([{...article('administracion'),translations:{es:copy,en:copy}}]).length);
  assert.ok(reviewHelpCorpus([article('soporte'),article('soporte')]).length);
});
