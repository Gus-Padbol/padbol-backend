import assert from 'node:assert/strict';
import test from 'node:test';

import { CRM_QUALIFIED_HANDOFF_MESSAGE } from './crmService.js';
import { createCrmFunnel, parseCrmFunnelPaths } from './crmFunnel.js';
import { createWhatsappLanguageMenu } from './whatsappLanguageMenu.js';

function harness(paths, languageMenu = null) {
  const conversation = { id: 'conversation-1', funnel_state: 'awaiting_path', selected_path: null,
    qualification_data: {}, qualification_question_count: 0, next_step: null, updated_at: '2026-09-17T12:00:00.000Z' };
  const replies = [];
  const inboundIds = new Set();
  const crmService = {
    async ingestInbound(input) {
      if (inboundIds.has(input.sourceId)) return { status: 'idempotent', conversation };
      inboundIds.add(input.sourceId);
      return { status: 'accepted', conversation };
    },
    async recordQualificationProgress({ conversationId, ...state }) {
      assert.equal(conversationId, conversation.id);
      if (state.expectedUpdatedAt && state.expectedUpdatedAt !== conversation.updated_at) throw new Error('CRM_QUALIFICATION_CONFLICT');
      conversation.updated_at = new Date(Date.parse(conversation.updated_at) + 1).toISOString();
      Object.assign(conversation, { funnel_state: state.funnelState, selected_path: state.selectedPath ?? null,
        qualification_data: state.qualificationData, qualification_question_count: state.questionsAsked,
        qualification_status: state.qualificationStatus, next_prompt: state.nextPrompt,
        prompt_options: state.promptOptions, next_step: state.nextStep, handoff_ready: state.handoffReady ?? false });
      return { ...conversation };
    },
    async createPendingReply(reply) { replies.push({ ...reply, status: 'pending' }); return replies.at(-1); },
  };
  return { funnel: createCrmFunnel({ crmService, paths, languageMenu }), conversation, replies };
}

const configuredPaths = [{ id: 'club', label: 'Club o complejo deportivo', questions: [
  { id: 'city', field: 'city', prompt: '¿En qué ciudad?', options: [] },
  { id: 'courts', field: 'courts', prompt: '¿Cuántas canchas?', options: ['1', '2 o más'] },
] }, { id: 'regional', label: 'Desarrollo regional', questions: [
  { id: 'has_club', field: 'has_existing_club', prompt: '¿Partís de un club existente?', options: [
    { id: 'yes', label: 'Sí', value: true }, { id: 'no', label: 'No', value: false },
  ] },
] }];

let sequence = 0;
function inbound(body) {
  sequence += 1;
  return { providerMessageId: `wamid.${sequence}`, phoneNumberId: '123456789',
    fromWaId: '5492215550101', body, receivedAt: '2026-09-17T12:00:00Z' };
}

test('un adjunto no disponible se registra sin avanzar la calificación', async () => {
  const h = harness(configuredPaths);
  await h.funnel.ingestWhatsapp(inbound('1'));
  const before = structuredClone(h.conversation);
  const result = await h.funnel.ingestWhatsapp({ ...inbound('[Archivo aún no disponible]'), mediaType: 'image' });
  assert.equal(result.response, null);
  assert.deepEqual(h.conversation, before);
});

test('embudo WhatsApp persiste camino, respuestas y club; cada salida queda pending', async () => {
  const h = harness(configuredPaths);
  await h.funnel.ingestWhatsapp(inbound('Hola'));
  assert.equal(h.conversation.funnel_state, 'awaiting_path');
  assert.equal(h.conversation.prompt_options.length, 2);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.equal(h.conversation.next_step, 'city');
  await h.funnel.ingestWhatsapp(inbound('Córdoba'));
  await h.funnel.ingestWhatsapp(inbound('2'));
  assert.equal(h.conversation.qualification_question_count, 2);
  assert.equal(h.conversation.next_step, 'club_name');
  await h.funnel.ingestWhatsapp(inbound('Club Central'));
  await h.funnel.ingestWhatsapp(inbound('Córdoba, Argentina'));
  assert.equal(h.conversation.qualification_status, 'qualified');
  assert.equal(h.conversation.handoff_ready, true);
  assert.equal(h.conversation.qualification_data.club_name, 'Club Central');
  assert.equal(h.conversation.qualification_data.club_location, 'Córdoba, Argentina');
  assert.equal(h.replies.at(-1).body, CRM_QUALIFIED_HANDOFF_MESSAGE);
  assert.ok(h.replies.every((reply) => reply.status === 'pending'));
});

test('seguimiento de club sólo aparece cuando el camino lo declara', async () => {
  const withoutClub = harness(configuredPaths);
  await withoutClub.funnel.ingestWhatsapp(inbound('hola'));
  await withoutClub.funnel.ingestWhatsapp(inbound('regional'));
  await withoutClub.funnel.ingestWhatsapp(inbound('no'));
  assert.equal(withoutClub.conversation.handoff_ready, true);
  assert.equal(withoutClub.conversation.next_step, 'advisor_handoff');
  const withClub = harness(configuredPaths);
  await withClub.funnel.ingestWhatsapp(inbound('hola'));
  await withClub.funnel.ingestWhatsapp(inbound('regional'));
  await withClub.funnel.ingestWhatsapp(inbound('yes'));
  assert.equal(withClub.conversation.next_step, 'club_name');
  assert.equal(withClub.conversation.qualification_question_count, 1);
});

test('configuración inválida falla cerrada sin inventar caminos', () => {
  assert.deepEqual(parseCrmFunnelPaths('{bad json'), []);
  assert.deepEqual(parseCrmFunnelPaths([{ id: 'x', label: 'X', questions: new Array(4).fill({
    id: 'q', field: 'f', prompt: 'P',
  }) }]), []);
});

test('sin embudo configurado igualmente registra el mensaje en la bandeja CRM', async () => {
  const h = harness([]);
  const result = await h.funnel.ingestWhatsapp(inbound('Prueba'));
  assert.equal(result.conversation.id, h.conversation.id);
  assert.equal(result.response, null);
  assert.equal(h.replies.length, 0);
});


test('menú detecta idioma, persiste opción siete y no reenvía tras seleccionar', async () => {
  let calls = 0;
  const languageMenu = { async resolve() { calls++; return { language: 'es', body: 'Bienvenido!\n1. A\n2. B\n3. C\n4. D\n5. E\n6. F', menu: { humanPrompt: 'Welche Sprache?', confirmation: 'Danke', labels: ['A', 'B', 'C', 'D', 'E', 'F'] } }; } };
  const h = harness([], languageMenu);
  h.conversation.qualification_status = 'pending';
  const first = inbound('Hola');
  await h.funnel.ingestWhatsapp(first);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.language, 'es');
  assert.equal((await h.funnel.ingestWhatsapp(first)).response, h.conversation.next_prompt);
  assert.equal(calls, 1);
  await h.funnel.ingestWhatsapp(inbound('7'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.topic, 'otros');
  assert.match(h.conversation.next_prompt, /Cuéntanos brevemente/);
  await h.funnel.ingestWhatsapp(inbound('Necesito ayuda'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.humanLanguage, 'es');
  assert.equal((await h.funnel.ingestWhatsapp(inbound('Bitte helfen'))).response, null);
  const old = await h.funnel.ingestWhatsapp(first);
  assert.equal(old.response, null);
  assert.equal(old.suppressAutomaticReply, true);
  await h.funnel.ingestWhatsapp(inbound('language: English'));
  assert.equal(calls, 2);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.stage, 'topic');
});

test('sin idioma cierto ofrece elección y conserva los datos previos', async () => {
  const h = harness([], { resolve: async () => null });
  h.conversation.qualification_data = { existing: 'preservado' };
  const result = await h.funnel.ingestWhatsapp(inbound('🙂'));
  assert.match(result.response, /Idioma/);
  assert.equal(h.conversation.qualification_data.existing, 'preservado');
  assert.equal(h.conversation.qualification_data.whatsapp_menu.language, null);
});

test('replay recupera un mensaje guardado antes de crear estado del menú', async () => {
  let first = true;
  const menu = { resolve: async () => {
    if (first) { first = false; throw Error('interrupted'); }
    return { language: 'en', body: 'Welcome\n1. A\n2. B\n3. C\n4. D\n5. E\n6. F', menu: { humanPrompt: 'Welche Sprache?', confirmation: 'Danke', labels: ['A', 'B', 'C', 'D', 'E', 'F'] } };
  } };
  const h = harness([], menu);
  const message = inbound('Hello');
  await assert.rejects(() => h.funnel.ingestWhatsapp(message), /interrupted/);
  const replay = await h.funnel.ingestWhatsapp(message);
  assert.equal(replay.conversation.qualification_data.whatsapp_menu.language, 'en');
});



test('idioma sin revisión conserva preferencia y no envía menú inventado', async () => {
  const h = harness([], { resolve: async () => null });
  await h.funnel.ingestWhatsapp(inbound('Hello'));
  const result = await h.funnel.ingestWhatsapp(inbound('2'));
  assert.equal(result.suppressAutomaticReply, true);
  assert.equal(result.conversation.qualification_data.whatsapp_menu.humanLanguage, 'en');
  assert.equal(result.conversation.qualification_status, 'needs_review');
});


test('submenú orienta, recoge detalle libre y permite volver al inicio', async () => {
  const menu = { resolve: async () => ({ language: 'es', body: 'Menú', menu: {
    confirmation: 'Gracias. Hemos registrado tu consulta.', labels: ['A', 'B', 'C', 'D', 'E', 'F'] } }) };
  const h = harness([], menu);
  await h.funnel.ingestWhatsapp(inbound('Hola'));
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(h.conversation.next_prompt, /Comprar una cancha/);
  assert.match(h.conversation.next_prompt, /0\. Volver al menú/);
  await h.funnel.ingestWhatsapp(inbound('2'));
  assert.match(h.conversation.next_prompt, /tu consulta y tu país/);
  await h.funnel.ingestWhatsapp(inbound('0'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.stage, 'topic');
  await h.funnel.ingestWhatsapp(inbound('5'));
  await h.funnel.ingestWhatsapp(inbound('Quiero consultar sobre FIPA'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.stage, 'selected');
  assert.equal(h.conversation.qualification_status, 'needs_review');
});


test('flujo inglés de prueba guía las opciones y registra la consulta', async () => {
  const languageMenu = createWhatsappLanguageMenu({ env: { CRM_WHATSAPP_ENGLISH_MENU_QA_PREVIEW: 'true',
    BACKEND_RUNTIME_MODE: 'staging', STAGING_SUPABASE_PROJECT_REF: 'vxikhdulhuvghfqeutnp' } });
  const h = harness([], languageMenu);
  await h.funnel.ingestWhatsapp(inbound('🙂'));
  await h.funnel.ingestWhatsapp(inbound('2'));
  assert.match(h.conversation.next_prompt, /What would you like to ask about/);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(h.conversation.next_prompt, /Buy a court/);
  await h.funnel.ingestWhatsapp(inbound('2'));
  assert.match(h.conversation.next_prompt, /tell us your country/);
  await h.funnel.ingestWhatsapp(inbound('A court in Germany'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.humanLanguage, 'en');
  assert.match(h.conversation.next_prompt, /recorded your inquiry/);
});


test('un estado previo en inglés no responde cuando se apaga la vista previa QA', async () => {
  const h = harness([], createWhatsappLanguageMenu({ env: {} }));
  h.conversation.qualification_data = { whatsapp_menu: { language: 'en', stage: 'subtopic', topic: 'sede' } };
  const result = await h.funnel.ingestWhatsapp(inbound('1'));
  assert.equal(result.response, null);
  assert.equal(result.suppressAutomaticReply, true);
});

test('menú atómico recupera recepción parcial y replay reutiliza la misma salida', async () => {
  const conversation = { id:'c', updated_at:'2026-10-21T12:00:00.000Z', qualification_data:{},
    qualification_status:'pending', next_step:null, selected_path:null };
  const events = new Map(); let commits = 0;
  const crmService = { async ingestInbound() { return {status:'idempotent',conversation}; },
    async recordQualificationProgress(){throw Error('must not use legacy persistence');},
    async createPendingReply(){throw Error('must not use legacy draft');} };
  const atomicMenuStore = { async findByInbound(id){return events.get(id)||null;},
    async commit({inboundId,conversationId,state,response}) { commits++;
      Object.assign(conversation,{qualification_data:state.qualification_data,qualification_status:state.qualification_status,
        next_step:state.next_step,next_prompt:state.next_prompt});
      const event={conversation_id:conversationId,outbox_id:'out-1'};events.set(inboundId,event);
      assert.ok(response);return {created:true,outbox_id:event.outbox_id}; } };
  const funnel=createCrmFunnel({crmService,languageMenu:createWhatsappLanguageMenu(),atomicMenuStore});
  const input={...inbound('Hola'), menuDelivery:{inboundId:'in-1',idempotencyKey:'a'.repeat(64)}};
  assert.equal((await funnel.ingestWhatsapp(input)).outboxId,'out-1');
  assert.equal((await funnel.ingestWhatsapp(input)).outboxId,'out-1');assert.equal(commits,1);
});


test('transición atómica del selector anterior preserva datos y no reinicia consultas calificadas', async () => {
  const base = {id:'c', updated_at:'2026-10-21T12:00:00.000Z', funnel_state:'awaiting_path',
    selected_path:null, next_step:'select_path', qualification_status:'pending',
    qualification_question_count:0, handoff_ready:false, qualification_data:{existing:'preservado'}};
  for (const changes of [{}, {selected_path:'club'}, {qualification_status:'qualified'},
    {qualification_question_count:1}, {handoff_ready:true}, {funnel_state:'question:city'}, {next_step:'city'}]) {
    const conversation = {...base,...changes,qualification_data:{...base.qualification_data}};
    let committed = null;
    const crmService = { async ingestInbound(){return {status:'accepted',conversation};},
      async recordQualificationProgress(){throw Error('unexpected legacy write');},
      async createPendingReply(){throw Error('unexpected legacy draft');} };
    const atomicMenuStore = {async findByInbound(){return null;}, async commit(args){committed=args;return {outbox_id:'out-1'};}};
    const languageMenu={async resolve(){return null;}};
    const funnel=createCrmFunnel({crmService,languageMenu,atomicMenuStore});
    const result=await funnel.ingestWhatsapp({...inbound('Hola'),menuDelivery:{inboundId:'in-1',idempotencyKey:'a'.repeat(64)}});
    if (Object.keys(changes).length===0) {
      assert.equal(result.outboxId,'out-1');
      assert.equal(committed.state.qualification_data.existing,'preservado');
      assert.equal(committed.state.qualification_data.whatsapp_menu.stage,'language');
      assert.match(committed.response,/Idioma/);
    } else { assert.equal(committed,null); assert.equal(result.outboxId,undefined); }
  }
});


test('Soporte principal registra el error y prepara atención humana', async () => {
  const menu={resolve:async()=>({language:'es',body:'Menú',menu:{confirmation:'Gracias. Hemos registrado tu consulta.',labels:['A','B','C','D','E','F','G']}})};
  const h=harness([],menu);
  await h.funnel.ingestWhatsapp(inbound('Hola'));
  await h.funnel.ingestWhatsapp(inbound('6'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.topic,'soporte');
  assert.match(h.conversation.next_prompt,/qué error encontraste y en qué producto/);
  await h.funnel.ingestWhatsapp(inbound('Error en el marcador'));
  assert.equal(h.conversation.qualification_status,'needs_review');
  assert.equal(h.conversation.next_step,'advisor_handoff');
  assert.equal(h.conversation.handoff_ready,false);
  assert.match(h.conversation.next_prompt,/Hemos registrado/);
});

test('solicitud de asesor desde el menú y submenús registra derivación y usa el texto aprobado', async () => {
  for (const step of ['topic', 'subtopic', 'details']) {
    const h = harness([], createWhatsappLanguageMenu());
    h.conversation.qualification_data = { existing: 'preserved', whatsapp_menu: {
      stage: step, language: 'es', topic: step === 'topic' ? null : 'sede', confirmation: 'Gracias.' } };
    const result = await h.funnel.ingestWhatsapp(inbound('Quiero hablar con un asesor'));
    assert.equal(result.response, '¡Con mucho gusto te pondremos en contacto con un asesor!\n\nEstamos recibiendo muchas consultas y nuestra atención no está disponible las 24 horas. Te pedimos un poco de paciencia: un asesor se comunicará contigo en cuanto sea posible.\n\nGracias por tu interés en Padbol.');
    assert.equal(h.conversation.handoff_ready, false);
    assert.equal(h.conversation.next_step, 'advisor_handoff');
    assert.equal(h.conversation.qualification_status, 'needs_review');
    assert.equal(h.conversation.qualification_data.existing, 'preserved');
    assert.equal(h.conversation.qualification_data.whatsapp_menu.topic, step === 'topic' ? null : 'sede');
    assert.equal((await h.funnel.ingestWhatsapp(inbound('Gracias'))).response, null);
  }
});

test('opción de asesor aparece en el menú y sus pasos; inglés queda restringido a QA', async () => {
  const h = harness([], createWhatsappLanguageMenu({ env: {} }));
  await h.funnel.ingestWhatsapp(inbound('es'));
  assert.match(h.conversation.next_prompt, /8\. Hablar con un asesor/);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(h.conversation.next_prompt, /8\. Hablar con un asesor/);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(h.conversation.next_prompt, /8\. Hablar con un asesor/);
  await h.funnel.ingestWhatsapp(inbound('8'));
  assert.equal(h.conversation.handoff_ready, false);
  const en = harness([], createWhatsappLanguageMenu({ env: {} }));
  en.conversation.qualification_data.whatsapp_menu = { language: 'en', stage: 'topic' };
  assert.equal((await en.funnel.ingestWhatsapp(inbound('8'))).response, null);
});
