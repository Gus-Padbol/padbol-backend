import {
  CRM_CLUB_ORGANIZATION_TYPE,
  CRM_QUALIFIED_HANDOFF_MESSAGE,
  clubFollowUpForQualification,
} from './crmService.js';
import { LANGUAGE_PROMPT, MENU_TOPICS, SPANISH_SUBMENUS, SPANISH_DETAILS_PROMPT, SPANISH_MENU, ENGLISH_DETAILS_PROMPT, ENGLISH_MENU, ENGLISH_SUBMENUS, renderLanguageMenu, ADVISOR_HANDOFF_ES, ADVISOR_HANDOFF_EN, ADVISOR_OPTION_ES, ADVISOR_OPTION_EN, topicPrompt, detectExplicitTopic } from './whatsappLanguageMenu.js';

const MAX_PATHS = 12;

function text(value, max = 2000) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

function optionList(items) {
  return items.map((item) => ({ id: item.id, label: item.label }));
}

function renderPrompt(prompt, options = []) {
  if (!options.length) return prompt;
  return `${prompt}\n${options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}`;
}

function selectedOption(input, options) {
  const normalized = text(input, 160)?.toLocaleLowerCase('es') ?? '';
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) return options[numeric - 1];
  return options.find((option) => (
    option.id.toLocaleLowerCase('es') === normalized
    || option.label.toLocaleLowerCase('es') === normalized
  )) || null;
}

export function parseCrmFunnelPaths(raw) {
  if (!raw) return [];
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!Array.isArray(value) || value.length > MAX_PATHS) return [];
  const paths = value.map((path) => ({
    id: text(path?.id, 80),
    label: text(path?.label, 160),
    questions: Array.isArray(path?.questions) ? path.questions.map((question) => ({
      id: text(question?.id, 80),
      field: text(question?.field, 80),
      prompt: text(question?.prompt, 1000),
      options: Array.isArray(question?.options)
        ? question.options.map((option) => typeof option === 'string'
          ? ({ id: text(option, 80), label: text(option, 160), value: text(option, 160) })
          : ({ id: text(option?.id, 80), label: text(option?.label, 160), value: option?.value ?? option?.label }))
        : [],
    })) : [],
  }));
  if (paths.some((path) => !path.id || !path.label || path.questions.some((question) => (
    !question.id || !question.field || !question.prompt
    || question.options.some((option) => !option.id || !option.label)
  )))) return [];
  if (paths.some((path) => path.questions.length > (path.id === 'national' ? 4 : 3))) return [];
  return paths;
}

/** Motor guiado: sólo persiste estado y borradores pending; nunca transporta mensajes. */
export function createCrmFunnel({ crmService, paths = [], languageMenu = null, atomicMenuStore = null } = {}) {
  const configuredPaths = parseCrmFunnelPaths(paths);
  if (!crmService) throw new Error('CRM funnel service is required');

  async function persistLegacy(conversationId, state, response) {
    const conversation = await crmService.recordQualificationProgress({ conversationId, ...state });
    await crmService.createPendingReply({ conversationId, body: response, operador: 'crm_funnel' });
    return { conversation, response };
  }

  return {
    get configured() { return configuredPaths.length > 0; },

    async ingestWhatsapp({ providerMessageId, phoneNumberId, fromWaId, body, textBody, receivedAt, mediaType, menuDelivery = null, ticketReference = null } = {}) {
      const inboundBody = body ?? textBody;
      const ingested = await crmService.ingestInbound({
        source: 'whatsapp_cloud', sourceId: providerMessageId, channel: 'whatsapp',
        phone: fromWaId, identityUsed: fromWaId, origin: `whatsapp:${phoneNumberId}`,
        body: inboundBody, receivedAt,
      });
      const conversation = ingested.conversation;
      const atomic = Boolean(atomicMenuStore && menuDelivery?.inboundId && menuDelivery?.idempotencyKey);
      // Once order is uncertain, keep accepting the original messages in the
      // inbox but stop automated routing until a human resolves the review.
      if (conversation?.qualification_data?.whatsapp_order_review?.required === true) {
        return { response: null, suppressAutomaticReply: true, conversation };
      }
      if (atomic && conversation?.qualification_data?.whatsapp_menu?.language === 'en'
          && !languageMenu?.englishPreviewAvailable) {
        return { response: null, suppressAutomaticReply: true, conversation };
      }
      if (atomic) {
        const existing = await atomicMenuStore.findByInbound(menuDelivery.inboundId);
        if (existing) {
          if (existing.conversation_id !== conversation.id) throw new Error('CRM_MENU_EVENT_MISMATCH');
          return { conversation, outboxId: existing.outbox_id, menuRevision: existing.menu_revision ?? null, suppressAutomaticReply: !existing.outbox_id };
        }
      }
      const ticketedConfirmation = menuState => {
        if (!ticketReference) return menuState.confirmation;
        if (!atomic || !/^PB-[0-9A-F]{32}$/.test(ticketReference)) throw new Error('CRM_TICKET_REFERENCE_INVALID');
        return `${menuState.confirmation}\n${menuState.language === 'en' ? 'Ticket number' : 'Número de ticket'}: ${ticketReference}`;
      };
      let atomicTransition = false;
      async function persist(conversationId, state, response) {
        if (!atomicTransition) return persistLegacy(conversationId, state, response);
        const committed = await atomicMenuStore.commit({ inboundId: menuDelivery.inboundId, conversationId,
          expectedUpdatedAt: state.expectedUpdatedAt, idempotencyKey: menuDelivery.idempotencyKey,
          response, state: { funnel_state: state.funnelState, selected_path: state.selectedPath ?? null,
            qualification_data: state.qualificationData, qualification_question_count: state.questionsAsked ?? 0,
            qualification_status: state.qualificationStatus, next_prompt: state.nextPrompt ?? null,
            prompt_options: state.promptOptions ?? [], next_step: state.nextStep ?? null,
            handoff_ready: Boolean(state.handoffReady) } });
        return { conversation, response, outboxId: committed.outbox_id, menuRevision: committed.revision ?? null, suppressAutomaticReply: !committed.outbox_id };
      }
      // An unavailable attachment notice must not become an answer in the funnel.
      if (mediaType) return { response: null, suppressAutomaticReply: true, conversation };
      // The language menu is opt-in and stays a draft until production's
      // separate delivery gate is deliberately enabled. Never restart existing
      // qualification or reinterpret an already-selected topic.
      const menuState = conversation?.qualification_data?.whatsapp_menu;
      // The old chooser can be safely upgraded only before any qualification
      // progress or human handoff, and only through the atomic QA delivery path.
      const legacyChooser = atomic && conversation?.funnel_state === 'awaiting_path'
        && conversation?.next_step === 'select_path' && !conversation?.selected_path
        && (!conversation?.qualification_status || conversation.qualification_status === 'pending')
        && Number(conversation?.qualification_question_count || 0) === 0
        && !conversation?.handoff_ready;
      const canUseLanguageMenu = languageMenu && (menuState || legacyChooser || (!conversation?.selected_path
        && !conversation?.next_step && (!conversation?.qualification_status || conversation.qualification_status === 'pending')));
      if (canUseLanguageMenu) {
        atomicTransition = atomic;
        if (!conversation?.updated_at) throw new Error('CRM_MENU_REVISION_MISSING');
        // A previous QA conversation cannot keep emitting English after the
        // QA-only preview gate is switched off or in another environment.
        if (menuState?.language === 'en' && !languageMenu.englishPreviewAvailable) {
          return { response: null, suppressAutomaticReply: true, conversation };
        }
        if (!atomic && ingested.status === 'idempotent' && menuState) {
          // Never reuse the current prompt for an older event: it may belong to
          // a different language or stage. Suppress rather than guess.
          const response = menuState?.lastEventId === providerMessageId ? menuState.lastResponse : null;
          return { response, suppressAutomaticReply: !response, conversation };
        }
        const data = { ...(conversation?.qualification_data || {}) };
        const input = String(inboundBody || '').trim();
        // A deliberate command lets a contact change language at any stage.
        const change = input.match(/^(?:idioma|language|langue|sprache|limb[ăa]|língua|اللغة)(?:\s*[:\-]\s*|\s+|$)(.*)$/iu);
        // QA follow-up menu does not reopen or replace the pending human request.
        // All routing state remains separate from the original handoff.
        const followupSafe = menuState?.stage === 'selected' && !change
          && conversation.next_step === 'advisor_handoff' && conversation.qualification_status === 'needs_review'
          && conversation.estado === 'nuevo' && conversation.operador === null && conversation.derivado === false;
        const greetingLanguage = /^(?:hi|hello|good morning|good afternoon|good evening)[\s.!¡,]*$/iu.test(input) ? 'en' : /^(?:hola(?:[\s,]+(?:buen(?:os)? d[ií]as?|buenas tardes|buenas noches))?|buen(?:os)? d[ií]as?|buenas tardes|buenas noches)[\s.!¡,]*$/iu.test(input) ? 'es' : null;
        if (followupSafe && (greetingLanguage || menuState.followup?.stage)) {
          // English remains gated to the dedicated private QA preview.
          if ((greetingLanguage === 'en' || (!greetingLanguage && menuState.followup?.language === 'en'))
              && !languageMenu.englishPreviewAvailable) return { response: null, suppressAutomaticReply: true, conversation };
          const lang = greetingLanguage || menuState.followup.language;
          const localeMenu = lang === 'en' ? ENGLISH_MENU : SPANISH_MENU;
          const submenus = lang === 'en' ? ENGLISH_SUBMENUS : SPANISH_SUBMENUS;
          const previous = menuState.followup || {};
          let followup; let prompt;
          if (greetingLanguage || input === '0') {
            followup = { stage: 'topic', language: lang };
            prompt = renderLanguageMenu(localeMenu);
          } else if (previous.stage === 'topic' && /^[1-7]$/.test(input)) {
            const topic = MENU_TOPICS[Number(input) - 1];
            const submenu = submenus[topic];
            const options = submenu.options.map((label, index) => ({ id: String(index + 1), label }));
            followup = { stage: options.length ? 'subtopic' : 'details', language: lang, topic };
            prompt = topicPrompt(lang, topic, submenu);
          } else if (previous.stage === 'subtopic' && /^[1-4]$/.test(input)
              && submenus[previous.topic]?.options[Number(input) - 1]) {
            followup = { ...previous, stage: 'details', subtopic: submenus[previous.topic].options[Number(input) - 1] };
            prompt = lang === 'en' ? ENGLISH_DETAILS_PROMPT : SPANISH_DETAILS_PROMPT;
          } else if ((input === '8' && previous.stage !== 'topic') || /^(?:quiero\s+)?hablar\s+con\s+(?:un\s+)?asesor(?:a)?[.!]?$/iu.test(input) || /^(?:i(?:'d| would) like to )?(?:speak|talk) (?:to|with) (?:an? )?advisor[.!]?$/iu.test(input)) {
            followup = { ...previous, stage: null };
            prompt = lang === 'en' ? ADVISOR_HANDOFF_EN : ADVISOR_HANDOFF_ES;
          } else if (previous.stage === 'details' && input && input !== '8') {
            followup = { ...previous, stage: null, detail: input.slice(0, 2000) };
            prompt = localeMenu.confirmation;
          } else {
            followup = previous;
            prompt = previous.lastPrompt || renderLanguageMenu(localeMenu);
          }
          followup.lastPrompt = prompt;
          data.whatsapp_menu = { ...menuState, followup, lastEventId: providerMessageId, lastResponse: prompt };
          return persist(conversation.id, { funnelState: conversation.funnel_state, selectedPath: conversation.selected_path,
            qualificationData: data, qualificationStatus: conversation.qualification_status,
            nextPrompt: conversation.next_prompt, promptOptions: conversation.prompt_options || [],
            nextStep: conversation.next_step, handoffReady: conversation.handoff_ready,
            questionsAsked: conversation.qualification_question_count || 0, expectedUpdatedAt: conversation.updated_at }, prompt);
        }
        if ((menuState?.language === 'es' || menuState?.language === 'en') && menuState?.stage !== 'selected' && input === '0' && !change) {
          const currentMenu = menuState.language === 'en' ? ENGLISH_MENU : SPANISH_MENU;
          const prompt = renderLanguageMenu(currentMenu);
          data.whatsapp_menu = { ...menuState, stage: 'topic', topic: null, subtopic: null,
            lastEventId: providerMessageId, lastResponse: prompt };
          return persist(conversation.id, { funnelState: 'whatsapp_menu_topic', qualificationData: data,
            qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: MENU_TOPICS.map((id, i) => ({ id, label: currentMenu.labels[i] })),
            nextStep: 'whatsapp_menu_topic', questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
        }
        // An explicit request may interrupt any active menu step; record the
        // handoff and response together before sending, preserving the topic.
        const asksAdvisor = /^(?:8|(?:quiero\s+)?hablar\s+con\s+(?:un\s+)?asesor(?:a)?|(?:i(?:'d| would) like to )?(?:speak|talk) (?:to|with) (?:an? )?advisor)[.!]?$/iu.test(input);
        if (!change && asksAdvisor && ['topic', 'confirm_topic', 'subtopic', 'details', 'selected'].includes(menuState?.stage) && !menuState.handoffRequested
            && ['es', 'en'].includes(menuState.language)
            && (menuState.stage !== 'selected' || followupSafe)) {
          if (!menuState.topic && !menuState.initialMessage) {
            const prompt = menuState.language === 'en' ? 'To help you, please briefly tell us what you need.' : 'Para ayudarte, cuéntanos brevemente qué necesitas.';
            data.whatsapp_menu = { ...menuState, stage: 'details', topic: 'otros', advisorRequested: true,
              lastEventId: providerMessageId, lastResponse: prompt };
            return persist(conversation.id, { funnelState: 'whatsapp_menu_details', qualificationData: data,
              qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: [], nextStep: 'whatsapp_menu_details',
              handoffReady: false, questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
          }
          const prompt = menuState.language === 'en' ? ADVISOR_HANDOFF_EN : ADVISOR_HANDOFF_ES;
          data.whatsapp_menu = { ...menuState, stage: 'selected', humanLanguage: menuState.language,
            handoffRequested: true, lastEventId: providerMessageId, lastResponse: prompt };
          return persist(conversation.id, { funnelState: 'whatsapp_menu_selected', qualificationData: data,
            qualificationStatus: 'needs_review', nextPrompt: prompt, promptOptions: [], nextStep: 'advisor_handoff',
            handoffReady: false, questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
        }
        if (menuState?.stage === 'selected' && !change) return { response: null, suppressAutomaticReply: true, conversation };
        if (menuState?.stage === 'language' && !change && /^(?:2|english)$/iu.test(input) && !(await languageMenu.resolve(input))) {
          // The topic menu for these languages awaits native review. Preserve
          // the preferred support language and leave the inquiry to a person.
          const humanLanguage = 'en';
          data.whatsapp_menu = { stage: 'selected', language: null, humanLanguage,
            topic: null, lastEventId: providerMessageId, lastResponse: null };
          const selection = { funnelState: 'whatsapp_menu_selected', qualificationData: data,
            qualificationStatus: 'needs_review', nextPrompt: null, promptOptions: [], nextStep: 'advisor_handoff',
            questionsAsked: 0, expectedUpdatedAt: conversation.updated_at };
          if (atomic) return persist(conversation.id, selection, null);
          const updated = await crmService.recordQualificationProgress({ conversationId: conversation.id, ...selection });
          return { response: null, suppressAutomaticReply: true, conversation: updated };
        }
        if (menuState?.stage === 'confirm_topic' && !change) {
          if (input === '1') {
            const topic = menuState.proposedTopic;
            const submenu = (menuState.language === 'en' ? ENGLISH_SUBMENUS : SPANISH_SUBMENUS)[topic];
            if (!submenu) throw new Error('CRM_MENU_TOPIC_INVALID');
            const options = submenu.options.map((label, index) => ({ id: String(index + 1), label }));
            const prompt = topicPrompt(menuState.language, topic, submenu, Boolean(menuState.initialMessage));
            data.whatsapp_menu = { ...menuState, stage: options.length ? 'subtopic' : 'details', topic,
              lastEventId: providerMessageId, lastResponse: prompt };
            return persist(conversation.id, { funnelState: options.length ? 'whatsapp_menu_subtopic' : 'whatsapp_menu_details',
              qualificationData: data, qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: options,
              nextStep: options.length ? 'whatsapp_menu_subtopic' : 'whatsapp_menu_details', questionsAsked: 0,
              expectedUpdatedAt: conversation.updated_at }, prompt);
          }
          if (input === '2') {
            const currentMenu = menuState.language === 'en' ? ENGLISH_MENU : SPANISH_MENU;
            const prompt = renderLanguageMenu(currentMenu);
            data.whatsapp_menu = { ...menuState, stage: 'topic', proposedTopic: null, lastEventId: providerMessageId, lastResponse: prompt };
            return persist(conversation.id, { funnelState: 'whatsapp_menu_topic', qualificationData: data,
              qualificationStatus: 'pending', nextPrompt: prompt,
              promptOptions: MENU_TOPICS.map((id, i) => ({ id, label: currentMenu.labels[i] })),
              nextStep: 'whatsapp_menu_topic', questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
          }
          return { response: null, suppressAutomaticReply: true, conversation };
        }
        if (menuState?.stage === 'details' && !change) {
          if (!input) return { response: null, suppressAutomaticReply: true, conversation };
          const prompt = ticketedConfirmation({ ...menuState, confirmation: menuState.advisorRequested ? (menuState.language === 'en' ? ADVISOR_HANDOFF_EN : ADVISOR_HANDOFF_ES) : menuState.confirmation });
          data.whatsapp_menu = { ...menuState, ...(ticketReference ? { ticketReference } : {}), stage: 'selected', humanLanguage: menuState.language,
            initialMessage: menuState.initialMessage || String(inboundBody), detailMessage: String(inboundBody),
            lastEventId: providerMessageId, lastResponse: prompt };
          return persist(conversation.id, { funnelState: 'whatsapp_menu_selected', qualificationData: data,
            qualificationStatus: 'needs_review', nextPrompt: prompt, promptOptions: [], nextStep: 'advisor_handoff',
            handoffReady: false, questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
        }
        if (menuState?.stage === 'subtopic' && !change) {
          const submenu = (menuState.language === 'en' ? ENGLISH_SUBMENUS : SPANISH_SUBMENUS)[menuState.topic];
          if (!submenu) throw new Error('CRM_MENU_TOPIC_INVALID');
          const choice = Number(input);
          if (Number.isInteger(choice) && choice >= 1 && choice <= submenu.options.length) {
            const detailPrompt = menuState.initialMessage ? (menuState.language === 'en' ? 'We have received your message. You can add more information or speak with an advisor.' : 'Ya recibimos tu mensaje. Puedes añadir información o hablar con un asesor.') : (menuState.language === 'en' ? ENGLISH_DETAILS_PROMPT : SPANISH_DETAILS_PROMPT);
            const prompt = `${detailPrompt}\n\n${menuState.language === 'en' ? `${ADVISOR_OPTION_EN}\n0. Back to menu` : `${ADVISOR_OPTION_ES}\n0. Volver al menú`}`;
            data.whatsapp_menu = { ...menuState, stage: 'details', subtopic: submenu.options[choice - 1],
              lastEventId: providerMessageId, lastResponse: prompt };
            return persist(conversation.id, { funnelState: 'whatsapp_menu_details', qualificationData: data,
              qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: [], nextStep: 'whatsapp_menu_details',
              questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
          }
          // A free-text description is already the detail needed by an operator.
          if (input && !/^\d+$/.test(input)) {
            const prompt = ticketedConfirmation(menuState);
            data.whatsapp_menu = { ...menuState, ...(ticketReference ? { ticketReference } : {}), stage: 'selected', humanLanguage: menuState.language, subtopic: null,
              initialMessage: menuState.initialMessage || String(inboundBody), detailMessage: String(inboundBody),
              lastEventId: providerMessageId, lastResponse: prompt };
            return persist(conversation.id, { funnelState: 'whatsapp_menu_selected', qualificationData: data,
              qualificationStatus: 'needs_review', nextPrompt: prompt, promptOptions: [], nextStep: 'advisor_handoff',
              questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
          }
          const prompt = conversation.next_prompt;
          data.whatsapp_menu = { ...menuState, lastEventId: providerMessageId, lastResponse: prompt };
          return persist(conversation.id, { funnelState: 'whatsapp_menu_subtopic', qualificationData: data,
            qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: conversation.prompt_options || [],
            nextStep: 'whatsapp_menu_subtopic', questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
        }
        if (menuState?.stage === 'topic' && !change) {
          const choice = Number(input);
          if (Number.isInteger(choice) && choice >= 1 && choice <= MENU_TOPICS.length) {
            const topic = MENU_TOPICS[choice - 1];
            const submenu = (menuState.language === 'en' ? ENGLISH_SUBMENUS : SPANISH_SUBMENUS)[topic];
            const options = submenu.options.map((label, index) => ({ id: String(index + 1), label }));
            const prompt = topicPrompt(menuState.language, topic, submenu, Boolean(menuState.initialMessage));
            data.whatsapp_menu = { ...menuState, stage: submenu.options.length ? 'subtopic' : 'details', topic,
              lastEventId: providerMessageId, lastResponse: prompt };
            return persist(conversation.id, { funnelState: submenu.options.length ? 'whatsapp_menu_subtopic' : 'whatsapp_menu_details', qualificationData: data,
              qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: options,
              nextStep: submenu.options.length ? 'whatsapp_menu_subtopic' : 'whatsapp_menu_details', questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
          }
          const prompt = conversation.next_prompt;
          data.whatsapp_menu = { ...menuState, lastEventId: providerMessageId, lastResponse: prompt };
          return persist(conversation.id, { funnelState: 'whatsapp_menu_topic', qualificationData: data,
            qualificationStatus: 'pending', nextPrompt: prompt,
            promptOptions: conversation.prompt_options || [], nextStep: 'whatsapp_menu_topic', questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
        }
        const translated = await languageMenu.resolve(change ? change[1] : input);
        const substantive = input && /[\p{L}]/u.test(input) && !/^(?:[0-9]+|hola|hi|hello|español|espanol|spanish|english|ingl[eé]s|es|en)[.!]?$/iu.test(input);
        const initialMessage = menuState?.initialMessage || (!change && substantive ? String(inboundBody) : null);
        const proposedTopic = translated && initialMessage ? detectExplicitTopic(initialMessage) : null;
        const label = proposedTopic ? translated.menu.labels[MENU_TOPICS.indexOf(proposedTopic)] : null;
        const prompt = proposedTopic
          ? (translated.language === 'en' ? `We have received your message. Is your inquiry about ${label}?\n1. Yes\n2. Choose another topic` : `Ya recibimos tu mensaje. ¿Tu consulta es sobre ${label}?\n1. Sí\n2. Elegir otro tema`)
          : translated?.body || LANGUAGE_PROMPT;
        const stage = proposedTopic ? 'confirm_topic' : translated ? 'topic' : 'language';
        data.whatsapp_menu = translated
          ? { stage, language: translated.language, humanPrompt: translated.menu.humanPrompt, confirmation: translated.menu.confirmation, initialMessage, proposedTopic, lastEventId: providerMessageId, lastResponse: prompt }
          : { stage: 'language', language: null, initialMessage, lastEventId: providerMessageId, lastResponse: prompt };
        const options = translated && !proposedTopic ? MENU_TOPICS.map((id, index) => ({ id, label: translated.menu.labels[index] })) : [];
        return persist(conversation.id, { funnelState: `whatsapp_menu_${stage}`,
          qualificationData: data, qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: options,
          nextStep: `whatsapp_menu_${stage}`, questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
      }
      // La bandeja del CRM debe registrar todos los mensajes entrantes aunque
      // el embudo/respuesta automatica todavia no este configurado.
      if (!configuredPaths.length) return { response: null, conversation };
      if (ingested.status === 'idempotent') return { response: conversation?.next_prompt || null, conversation };
      const data = { ...(conversation?.qualification_data || {}) };
      let selectedPath = conversation?.selected_path || null;

      if (!selectedPath) {
        const choice = conversation?.funnel_state === 'awaiting_path'
          ? selectedOption(inboundBody, configuredPaths)
          : null;
        if (!choice) {
          const prompt = 'Elegí una opción para continuar:';
          return persist(conversation.id, {
            funnelState: 'awaiting_path', qualificationData: data,
            qualificationStatus: 'pending', nextPrompt: prompt,
            promptOptions: optionList(configuredPaths), nextStep: 'select_path', questionsAsked: 0,
          }, renderPrompt(prompt, configuredPaths));
        }
        selectedPath = choice.id;
      }

      const path = configuredPaths.find((candidate) => candidate.id === selectedPath);
      if (!path) {
        const prompt = 'Elegí una opción válida para continuar:';
        return persist(conversation.id, {
          funnelState: 'awaiting_path', selectedPath: null, qualificationData: {},
          qualificationStatus: 'pending', nextPrompt: prompt,
          promptOptions: optionList(configuredPaths), nextStep: 'select_path', questionsAsked: 0,
        }, renderPrompt(prompt, configuredPaths));
      }

      const pendingField = text(conversation?.next_step, 80);
      const pendingQuestion = path.questions.find((question) => question.field === pendingField);
      if (pendingQuestion) {
        const answer = pendingQuestion.options.length
          ? selectedOption(inboundBody, pendingQuestion.options)
          : { value: text(inboundBody, 1000) };
        if (!answer) {
          return persist(conversation.id, {
            funnelState: `question:${pendingQuestion.id}`, selectedPath, qualificationData: data,
            qualificationStatus: 'in_progress', nextPrompt: pendingQuestion.prompt,
            promptOptions: optionList(pendingQuestion.options), nextStep: pendingQuestion.field,
            questionsAsked: Number(conversation?.qualification_question_count || 0),
          }, renderPrompt(pendingQuestion.prompt, pendingQuestion.options));
        }
        data[pendingQuestion.field] = answer.value;
      } else if (pendingField === 'club_name' || pendingField === 'club_location') {
        data[pendingField] = text(inboundBody, pendingField === 'club_name' ? 160 : 240);
      }

      const answeredQuestions = path.questions.filter((question) => data[question.field] != null).length;
      const nextQuestion = path.questions.find((question) => data[question.field] == null);
      if (nextQuestion) {
        return persist(conversation.id, {
          funnelState: `question:${nextQuestion.id}`, selectedPath, qualificationData: data,
          qualificationStatus: 'in_progress', nextPrompt: nextQuestion.prompt,
          promptOptions: optionList(nextQuestion.options), nextStep: nextQuestion.field,
          questionsAsked: answeredQuestions,
        }, renderPrompt(nextQuestion.prompt, nextQuestion.options));
      }

      // Los identificadores del club son seguimientos condicionales y no consumen
      // el máximo de preguntas comerciales del camino.
      const clubFollowUp = clubFollowUpForQualification({ selectedPath, qualificationData: data });
      const missingClubField = clubFollowUp.find((item) => !text(data[item.field], item.field === 'club_name' ? 160 : 240));
      if (missingClubField) {
        const prompt = missingClubField.field === 'club_name'
          ? '¿Cuál es el nombre del club o complejo deportivo?'
          : '¿En qué ciudad y país está el club o complejo deportivo?';
        return persist(conversation.id, {
          funnelState: `club:${missingClubField.field}`, selectedPath, qualificationData: data,
          qualificationStatus: 'in_progress', nextPrompt: prompt, promptOptions: [],
          nextStep: missingClubField.field, questionsAsked: answeredQuestions,
        }, prompt);
      }

      return persist(conversation.id, {
        funnelState: 'qualified', selectedPath, qualificationData: data,
        qualificationStatus: 'qualified', nextPrompt: CRM_QUALIFIED_HANDOFF_MESSAGE,
        promptOptions: [], nextStep: 'advisor_handoff', handoffReady: true,
        questionsAsked: answeredQuestions,
      }, CRM_QUALIFIED_HANDOFF_MESSAGE);
    },
  };
}
