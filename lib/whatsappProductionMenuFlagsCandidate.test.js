import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWhatsappProductionMenuFlags } from './whatsappProductionMenuFlagsCandidate.js';
test('review persists after sender shutdown, and sender cannot run without review', () => {
  assert.deepEqual(resolveWhatsappProductionMenuFlags({}), {sendEnabled:false,reviewEnabled:false});
  assert.throws(() => resolveWhatsappProductionMenuFlags({WHATSAPP_PRODUCTION_MENU_ENABLED:'true'}), /WA_MENU_REVIEW_MUST_BE_ENABLED/);
  const env={WHATSAPP_PRODUCTION_MENU_ENABLED:'true',WHATSAPP_MENU_REVIEW_ENABLED:'true'};
  assert.deepEqual(resolveWhatsappProductionMenuFlags(env), {sendEnabled:true,reviewEnabled:true});
  env.WHATSAPP_PRODUCTION_MENU_ENABLED='false';
  assert.deepEqual(resolveWhatsappProductionMenuFlags(env), {sendEnabled:false,reviewEnabled:true});
});
