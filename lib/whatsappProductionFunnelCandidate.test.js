import assert from 'node:assert/strict';
import test from 'node:test';

import { CRM_QUALIFIED_HANDOFF_MESSAGE } from './crmService.js';
import { createCrmFunnel, parseCrmFunnelPaths } from './whatsappProductionFunnelCandidate.js';
import { createWhatsappLanguageMenu } from './whatsappLanguageMenuCandidate.js';

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
  assert.match(h.conversation.next_prompt, /Si necesitas más ayuda/);
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
  assert.match(h.conversation.next_prompt, /If you need further help/);
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
  assert.match(h.conversation.next_prompt,/captura de pantalla/);
  await h.funnel.ingestWhatsapp(inbound('Error en el marcador'));
  assert.equal(h.conversation.qualification_status,'needs_review');
  assert.equal(h.conversation.next_step,'advisor_handoff');
  assert.equal(h.conversation.handoff_ready,false);
  assert.match(h.conversation.next_prompt,/Hemos registrado/);
});

test('solicitud de asesor desde el menú y submenús registra derivación y usa el texto aprobado', async () => {
  for (const step of ['subtopic', 'details']) {
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
  assert.doesNotMatch(h.conversation.next_prompt, /8\. Hablar con un asesor/);
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


test('saludo mientras espera asesor muestra menú inglés sin alterar la solicitud', async () => {
  const h = harness([], createWhatsappLanguageMenu({ env: { CRM_WHATSAPP_ENGLISH_MENU_QA_PREVIEW: 'true', BACKEND_RUNTIME_MODE: 'staging', STAGING_SUPABASE_PROJECT_REF: 'vxikhdulhuvghfqeutnp' } }));
  Object.assign(h.conversation, { funnel_state: 'whatsapp_menu_selected', selected_path: 'club',
    qualification_status: 'needs_review', next_step: 'advisor_handoff', next_prompt: 'Mensaje previo',
    estado: 'nuevo', operador: null, derivado: false,
    prompt_options: [{ id: 'x', label: 'Opción' }], qualification_question_count: 2, handoff_ready: false,
    qualification_data: { detail: 'Consulta', whatsapp_menu: { stage: 'selected', language: 'es',
      topic: 'sede', subtopic: 'Abrir', humanLanguage: 'es', handoffRequested: true } } });
  const before = structuredClone(h.conversation);
  const result = await h.funnel.ingestWhatsapp(inbound('HI'));
  assert.match(result.response, /^Hello! Welcome to Padbol/);
  for (const field of ['funnel_state', 'selected_path', 'qualification_status', 'next_step', 'next_prompt',
    'prompt_options', 'qualification_question_count', 'handoff_ready']) assert.deepEqual(h.conversation[field], before[field]);
  const {lastEventId, lastResponse, followup, ...state} = h.conversation.qualification_data.whatsapp_menu;
  assert.equal(followup.language, 'en');
  assert.equal(followup.stage, 'topic');
  assert.deepEqual(state, before.qualification_data.whatsapp_menu);
  assert.equal(h.conversation.qualification_data.detail, 'Consulta');
  assert.match((await h.funnel.ingestWhatsapp(inbound('1'))).response, /Open a venue/);
  assert.match((await h.funnel.ingestWhatsapp(inbound('1'))).response, /If you need further help/);
  await h.funnel.ingestWhatsapp(inbound('I want a venue in London'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.followup.detail, 'I want a venue in London');
  assert.equal(h.conversation.next_step, 'advisor_handoff');
  assert.equal(h.conversation.qualification_status, 'needs_review');
});


test('saludo no genera respuesta si un operador atiende o la conversación fue derivada', async () => {
  for (const updates of [{ estado: 'en_atencion' }, { estado: 'derivado' }, { estado: 'cerrado' },
    { operador: 'operador@padbol.com' }, { derivado: true }, { estado: undefined },
    { operador: undefined }, { derivado: undefined }]) {
    const h = harness([], createWhatsappLanguageMenu());
    Object.assign(h.conversation, { estado: 'nuevo', operador: null, derivado: false,
      funnel_state: 'whatsapp_menu_selected', qualification_status: 'needs_review', next_step: 'advisor_handoff',
      qualification_data: { whatsapp_menu: { stage: 'selected', language: 'es', handoffRequested: true } }, ...updates });
    const result = await h.funnel.ingestWhatsapp(inbound('Hola'));
    assert.equal(result.response, null, JSON.stringify(updates));
    assert.equal(result.suppressAutomaticReply, true);
  }
});


test('cero al esperar atención no borra la solicitud humana', async () => {
  const h = harness([], createWhatsappLanguageMenu());
  Object.assign(h.conversation, { estado: 'nuevo', operador: null, derivado: false,
    funnel_state: 'whatsapp_menu_selected', qualification_status: 'needs_review', next_step: 'advisor_handoff',
    qualification_data: { whatsapp_menu: { stage: 'selected', language: 'es', handoffRequested: true } } });
  assert.equal((await h.funnel.ingestWhatsapp(inbound('0'))).response, null);
  assert.equal(h.conversation.next_step, 'advisor_handoff');
  assert.equal(h.conversation.qualification_status, 'needs_review');
});


test('menú principal es sencillo, abre información tras seleccionar tema y ofrece asesor', async () => {
  const h = harness([], createWhatsappLanguageMenu({ env: {} }));
  await h.funnel.ingestWhatsapp(inbound('es'));
  assert.doesNotMatch(h.conversation.next_prompt, /Hablar con un asesor/);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(h.conversation.next_prompt, /https:\/\/padbol\.com\/contacto/);
  assert.match(h.conversation.next_prompt, /8\. Hablar con un asesor/);
  await h.funnel.ingestWhatsapp(inbound('8'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.topic, 'sede');
  assert.equal(h.conversation.next_step, 'advisor_handoff');
});


test('primer mensaje detallado conserva texto y confirma intención sin repetir la consulta', async () => {
  const original = 'Hola, soy Ana y quiero abrir una sede en Valencia. ¿Qué requisitos hay?';
  const language = { englishPreviewAvailable: false, async resolve() { return { language: 'es', body: 'Menú',
    menu: { confirmation: 'Consulta recibida.', labels: ['Sede', 'Match', 'Next', 'Academy', 'FIPA', 'Soporte', 'Otros'] } }; } };
  const h = harness([], language);
  await h.funnel.ingestWhatsapp(inbound(original));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.initialMessage, original);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.stage, 'confirm_topic');
  assert.match(h.conversation.next_prompt, /¿Tu consulta es sobre Sede/);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(h.conversation.next_prompt, /no necesitas repetirlo/);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(h.conversation.next_prompt, /Ya recibimos tu mensaje/);
  assert.doesNotMatch(h.conversation.next_prompt, /Cuéntanos brevemente/);
  await h.funnel.ingestWhatsapp(inbound('8'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.initialMessage, original);
  assert.equal(h.conversation.next_step, 'advisor_handoff');
});

test('mensaje ambiguo no atribuye intención y mantiene íntegro el texto', async () => {
  const original = 'Me interesa Padbol Match y también quiero abrir una sede';
  const language = { async resolve() { return { language: 'es', body: 'Menú', menu: { labels: ['A','B','C','D','E','F','G'] } }; } };
  const h = harness([], language); await h.funnel.ingestWhatsapp(inbound(original));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.stage, 'topic');
  assert.equal(h.conversation.qualification_data.whatsapp_menu.proposedTopic, null);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.initialMessage, original);
});


test('pedir asesor sin contexto solicita una descripción breve antes de derivar', async () => {
  const h = harness([], createWhatsappLanguageMenu());
  h.conversation.qualification_data = { whatsapp_menu: { stage: 'topic', language: 'es' } };
  assert.match((await h.funnel.ingestWhatsapp(inbound('Quiero hablar con un asesor'))).response, /cuéntanos brevemente/);
  assert.equal(h.conversation.next_step, 'whatsapp_menu_details');
  const result = await h.funnel.ingestWhatsapp(inbound('Necesito saber cómo abrir una sede'));
  assert.match(result.response, /^¡Con mucho gusto te pondremos en contacto con un asesor!/);
  assert.equal(h.conversation.next_step, 'advisor_handoff');
});


test('problema de acceso a Padbol Match se propone como soporte, no compra comercial', async () => {
  const message = 'Hola, no puedo entrar a Padbol Match';
  const language = { async resolve() { return { language: 'es', body: 'Menú',
    menu: { labels: ['Sede','Match','Next','Academy','FIPA','Soporte','Otros'] } }; } };
  const h = harness([],language); await h.funnel.ingestWhatsapp(inbound(message));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.proposedTopic, 'soporte');
  assert.match(h.conversation.next_prompt, /consulta es sobre Soporte/);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.initialMessage, message);
});


test('marca de orden ambiguo detiene respuestas automáticas y conserva la conversación', async () => {
  const h = harness([], createWhatsappLanguageMenu());
  h.conversation.qualification_data = { whatsapp_order_review: { required:true, reason:'ambiguous_message_order' },
    whatsapp_menu: { stage:'topic', language:'es', topic:null } };
  h.conversation.next_step = 'advisor_handoff';
  for (const message of ['Hola', '1', 'Quiero hablar con un asesor', '0']) {
    const result = await h.funnel.ingestWhatsapp(inbound(message));
    assert.equal(result.response,null);
    assert.equal(result.suppressAutomaticReply,true);
    assert.equal(h.conversation.next_step,'advisor_handoff');
  }
});


test('saludo natural reabre el menú al esperar asesor sin alterar la solicitud', async () => {
  const h = harness([], createWhatsappLanguageMenu());
  Object.assign(h.conversation, { estado: 'nuevo', operador: null, derivado: false,
    funnel_state: 'whatsapp_menu_selected', qualification_status: 'needs_review', next_step: 'advisor_handoff',
    qualification_data: { whatsapp_menu: { stage: 'selected', language: 'es', handoffRequested: true } } });
  const result = await h.funnel.ingestWhatsapp(inbound('Hola buen día!'));
  assert.match(result.response, /Bienvenido a Padbol/);
  assert.equal(h.conversation.next_step, 'advisor_handoff');
  assert.equal(h.conversation.qualification_status, 'needs_review');
});

test('acuse de consulta usa la referencia de producción recibida y persiste con la salida atómica',async()=>{
  const reference='PB-11111111111141118111111111111111';
  const conversation={id:'qa-id',updated_at:'2026-10-21T12:00:00.000Z',qualification_status:'pending',next_step:'whatsapp_menu_details',selected_path:null,
    qualification_data:{whatsapp_menu:{stage:'details',language:'es',topic:'soporte',confirmation:'Gracias. Hemos registrado tu consulta.'}}};
  let committed;const crmService={async ingestInbound(){return {status:'accepted',conversation}}};
  const atomicMenuStore={async findByInbound(){return null},async commit(args){committed=args;return {outbox_id:'out'}}};
  const f=createCrmFunnel({crmService,languageMenu:{resolve:async()=>null},atomicMenuStore});
  await f.ingestWhatsapp({...inbound('Tengo un error'),ticketReference:reference,menuDelivery:{inboundId:'in',idempotencyKey:'a'.repeat(64)}});
  assert.match(committed.response,new RegExp(reference));assert.match(committed.response,/Conserva este número para dar seguimiento/);assert.equal(committed.state.qualification_data.whatsapp_menu.ticketReference,reference);assert.equal(committed.state.handoff_ready,false);
  await assert.rejects(()=>f.ingestWhatsapp({...inbound('Tengo otro error'),ticketReference:'PB-QA',menuDelivery:{inboundId:'in2',idempotencyKey:'b'.repeat(64)}}),/CRM_TICKET_REFERENCE_INVALID/);

});

test('consulta posterior confirma con ticket real sin borrar la derivación original', async () => {
  const reference='PB-11111111111141118111111111111111';
  const conversation={id:'qa-id',updated_at:'2026-10-21T12:00:00.000Z',estado:'nuevo',operador:null,derivado:false,
    funnel_state:'whatsapp_menu_selected',qualification_status:'needs_review',next_step:'advisor_handoff',handoff_ready:false,
    qualification_data:{whatsapp_menu:{stage:'selected',language:'es',followup:{stage:'details',language:'es',topic:'soporte'}}}};
  let committed;const crmService={async ingestInbound(){return {status:'accepted',conversation}}};
  const atomicMenuStore={async findByInbound(){return null},async commit(args){committed=args;return {outbox_id:'out'}}};
  const f=createCrmFunnel({crmService,languageMenu:createWhatsappLanguageMenu(),atomicMenuStore});
  await f.ingestWhatsapp({...inbound('Tengo un error'),ticketReference:reference,menuDelivery:{inboundId:'in',idempotencyKey:'a'.repeat(64)}});
  assert.match(committed.response,new RegExp(reference));
  assert.equal(committed.state.qualification_data.whatsapp_menu.followup.ticketReference,reference);
  assert.equal(committed.state.next_step,'advisor_handoff');
  assert.equal(committed.state.qualification_status,'needs_review');
});


test('saludo alargado muestra seguimiento solo mientras espera asesor, sin alterar solicitud', async () => {
  for (const input of ['Holaaaaaa', 'Holaaaaa!', 'holaaaa, buen día']) {
    const h = harness([], createWhatsappLanguageMenu());
    Object.assign(h.conversation, { estado: 'nuevo', operador: null, derivado: false,
      funnel_state: 'whatsapp_menu_selected', qualification_status: 'needs_review', next_step: 'advisor_handoff',
      qualification_data: { detail: 'consulta original', whatsapp_menu: { stage: 'selected', language: 'es', handoffRequested: true } } });
    const result = await h.funnel.ingestWhatsapp(inbound(input));
    assert.match(result.response, /Bienvenido a Padbol/);
    assert.equal(h.conversation.qualification_data.detail, 'consulta original');
    assert.equal(h.conversation.next_step, 'advisor_handoff');
    assert.equal(h.conversation.qualification_status, 'needs_review');
  }
  const assigned = harness([], createWhatsappLanguageMenu());
  Object.assign(assigned.conversation, { estado: 'nuevo', operador: 'operador', derivado: false,
    funnel_state: 'whatsapp_menu_selected', qualification_status: 'needs_review', next_step: 'advisor_handoff',
    qualification_data: { whatsapp_menu: { stage: 'selected', language: 'es' } } });
  assert.equal((await assigned.funnel.ingestWhatsapp(inbound('Holaaaaaa'))).response, null);
});

test('Next Generation clubes ofrece el formulario sin perder consulta ni ticket', async () => {
  const reference = 'PB-1234567890ABCDEF1234567890ABCDEF';
  const languageMenu = { resolve: async () => null, englishPreviewAvailable: true };
  const h = harness([], languageMenu);
  h.conversation.qualification_status = 'pending';
  h.conversation.qualification_data = { whatsapp_menu: { language: 'es', stage: 'subtopic', topic: 'next_generation', initialMessage: 'Mi club quiere participar', ticketReference: reference } };
  const result = await h.funnel.ingestWhatsapp(inbound('2'));
  assert.match(result.response, /https:\/\/padbol\.com\/next-generation\/adhesion/);
  assert.match(result.response, /Completa el formulario/);
  assert.doesNotMatch(result.response, /brevemente tu consulta y tu país/);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.initialMessage, 'Mi club quiere participar');
  assert.equal(h.conversation.qualification_data.whatsapp_menu.ticketReference, reference);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.subtopic, 'Clubes y sedes');
  assert.equal(h.conversation.qualification_data.whatsapp_menu.stage, 'details');
});

test('seguimiento de Next Generation ofrece formulario y conserva derivación', async () => {
  const reference = 'PB-1234567890ABCDEF1234567890ABCDEF';
  const h = harness([], { resolve: async () => null, englishPreviewAvailable: true });
  Object.assign(h.conversation, {estado: 'nuevo', operador: null, derivado: false, handoff_ready: false, next_step: 'advisor_handoff', qualification_status: 'needs_review', qualification_data: {whatsapp_menu: {stage: 'selected', language: 'es', initialMessage: 'Quiero abrir una sede', ticketReference: reference, followup: {stage:'subtopic', language:'es', topic:'next_generation'}}}});
  const result = await h.funnel.ingestWhatsapp(inbound('2'));
  assert.match(result.response, /https:\/\/padbol\.com\/next-generation\/adhesion/);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.initialMessage, 'Quiero abrir una sede');
  assert.equal(h.conversation.qualification_data.whatsapp_menu.ticketReference, reference);
  assert.equal(h.conversation.next_step, 'advisor_handoff');
  assert.equal(h.conversation.qualification_data.whatsapp_menu.followup.stage, 'details');
  assert.match(result.response, /Completa el formulario/);
  assert.doesNotMatch(result.response, /brevemente tu consulta y tu país/);
});

test('QA confirmation accepts a persisted short ticket while preserving the selected handoff', async () => {
  const reference='PB-100023';const conversation={id:'qa-id',updated_at:'2026-10-21T12:00:00.000Z',estado:'nuevo',operador:null,derivado:false,
    funnel_state:'whatsapp_menu_selected',qualification_status:'needs_review',next_step:'advisor_handoff',handoff_ready:false,
    qualification_data:{whatsapp_menu:{stage:'selected',language:'es',followup:{stage:'details',language:'es',topic:'soporte'}}}};
  let committed;const crmService={async ingestInbound(){return {status:'accepted',conversation}}};
  const atomicMenuStore={async findByInbound(){return null},async commit(args){committed=args;return {outbox_id:'out'}}};
  const f=createCrmFunnel({crmService,languageMenu:createWhatsappLanguageMenu(),atomicMenuStore});
  await f.ingestWhatsapp({...inbound('Tengo un error'),ticketReference:reference,menuDelivery:{inboundId:'in',idempotencyKey:'a'.repeat(64)}});
  assert.match(committed.response,/PB-100023/);assert.equal(committed.state.qualification_data.whatsapp_menu.followup.ticketReference,reference);
});

test('enlace informativo no afirma una solicitud y permite continuar la consulta', async () => {
  const h = harness([], { resolve: async () => null, englishPreviewAvailable: true });
  h.conversation.qualification_status = 'pending';
  h.conversation.qualification_data = { whatsapp_menu: { language:'es', stage:'subtopic', topic:'academy', confirmation:'Gracias. Hemos registrado tu consulta.' } };
  const first = await h.funnel.ingestWhatsapp(inbound('1'));
  assert.match(first.response, /https:\/\/padbol\.com\/academy\/cursos/);
  assert.match(first.response, /Si necesitas más ayuda/);
  assert.match(first.response, /8\. Hablar con un asesor/);
  assert.doesNotMatch(first.response, /ticket|solicitud registrada|hemos registrado/i);
  assert.equal(h.conversation.qualification_data.whatsapp_menu.stage, 'details');
  await h.funnel.ingestWhatsapp(inbound('Quisiera conocer los requisitos'));
  assert.equal(h.conversation.qualification_data.whatsapp_menu.detailMessage, 'Quisiera conocer los requisitos');
  assert.equal(h.conversation.qualification_status, 'needs_review');
});


test('production confirmation requires a persisted ticket and uses its short reference',async()=>{
  const conversation={id:'synthetic',updated_at:'2026-10-21T12:00:00Z',qualification_status:'pending',next_step:'whatsapp_menu_details',qualification_data:{whatsapp_menu:{stage:'details',language:'es',topic:'soporte'}}};
  let committed;const crmService={async ingestInbound(){return {status:'accepted',conversation}}};
  const atomicMenuStore={async findByInbound(){return null},async commit(args){committed=args;return {outbox_id:'synthetic'}}};
  const f=createCrmFunnel({crmService,languageMenu:{resolve:async()=>null},atomicMenuStore,requireTicketReference:true});
  const input={...inbound('Tengo un error'),menuDelivery:{inboundId:'synthetic',idempotencyKey:'a'.repeat(64)}};
  await assert.rejects(f.ingestWhatsapp(input),/CRM_TICKET_REFERENCE_REQUIRED/);assert.equal(committed,undefined);
  conversation.ticket_number=100087;await f.ingestWhatsapp(input);assert.match(committed.response,/PB-100087/);
});
