import {
  CRM_CLUB_ORGANIZATION_TYPE,
  CRM_QUALIFIED_HANDOFF_MESSAGE,
  clubFollowUpForQualification,
} from './crmService.js';
import { LANGUAGE_PROMPT, MENU_TOPICS, SPANISH_SUBMENUS, SPANISH_DETAILS_PROMPT, SPANISH_MENU, ENGLISH_DETAILS_PROMPT, ENGLISH_MENU, ENGLISH_SUBMENUS, renderLanguageMenu, ADVISOR_HANDOFF_ES, ADVISOR_HANDOFF_EN, ADVISOR_OPTION_ES, ADVISOR_OPTION_EN } from './whatsappLanguageMenu.js';

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

    async ingestWhatsapp({ providerMessageId, phoneNumberId, fromWaId, body, textBody, receivedAt, mediaType, menuDelivery = null } = {}) {
      const inboundBody = body ?? textBody;
      const ingested = await crmService.ingestInbound({
        source: 'whatsapp_cloud', sourceId: providerMessageId, channel: 'whatsapp',
        phone: fromWaId, identityUsed: fromWaId, origin: `whatsapp:${phoneNumberId}`,
        body: inboundBody, receivedAt,
      });
      const conversation = ingested.conversation;
      const atomic = Boolean(atomicMenuStore && menuDelivery?.inboundId && menuDelivery?.idempotencyKey);
      if (atomic && conversation?.qualification_data?.whatsapp_menu?.language === 'en'
          && !languageMenu?.englishPreviewAvailable) {
        return { response: null, suppressAutomaticReply: true, conversation };
      }
      if (atomic) {
        const existing = await atomicMenuStore.findByInbound(menuDelivery.inboundId);
        if (existing) {
          if (existing.conversation_id !== conversation.id) throw new Error('CRM_MENU_EVENT_MISMATCH');
          return { conversation, outboxId: existing.outbox_id, suppressAutomaticReply: !existing.outbox_id };
        }
      }
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
        return { conversation, response, outboxId: committed.outbox_id, suppressAutomaticReply: !committed.outbox_id };
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
        if ((menuState?.language === 'es' || menuState?.language === 'en') && input === '0' && !change) {
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
        if (!change && asksAdvisor && ['topic', 'subtopic', 'details', 'selected'].includes(menuState?.stage) && !menuState.handoffRequested
            && ['es', 'en'].includes(menuState.language)) {
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
        if (menuState?.stage === 'details' && !change) {
          if (!input) return { response: null, suppressAutomaticReply: true, conversation };
          const prompt = menuState.confirmation;
          data.whatsapp_menu = { ...menuState, stage: 'selected', humanLanguage: menuState.language,
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
            const prompt = menuState.language === 'en' ? `${ENGLISH_DETAILS_PROMPT}\n\n${ADVISOR_OPTION_EN}\n0. Back to menu` : `${SPANISH_DETAILS_PROMPT}\n\n${ADVISOR_OPTION_ES}\n0. Volver al menú`;
            data.whatsapp_menu = { ...menuState, stage: 'details', subtopic: submenu.options[choice - 1],
              lastEventId: providerMessageId, lastResponse: prompt };
            return persist(conversation.id, { funnelState: 'whatsapp_menu_details', qualificationData: data,
              qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: [], nextStep: 'whatsapp_menu_details',
              questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
          }
          // A free-text description is already the detail needed by an operator.
          if (input && !/^\d+$/.test(input)) {
            const prompt = menuState.confirmation;
            data.whatsapp_menu = { ...menuState, stage: 'selected', humanLanguage: menuState.language, subtopic: null,
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
            const prompt = `${renderPrompt(submenu.prompt, options)}\n\n${menuState.language === 'en' ? `${ADVISOR_OPTION_EN}\n0. Back to menu` : `${ADVISOR_OPTION_ES}\n0. Volver al menú`}`;
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
        const prompt = translated?.body || LANGUAGE_PROMPT;
        data.whatsapp_menu = translated
          ? { stage: 'topic', language: translated.language, humanPrompt: translated.menu.humanPrompt, confirmation: translated.menu.confirmation, lastEventId: providerMessageId, lastResponse: prompt }
          : { stage: 'language', language: null, lastEventId: providerMessageId, lastResponse: prompt };
        const options = translated ? MENU_TOPICS.map((id, index) => ({ id, label: translated.menu.labels[index] })) : [];
        return persist(conversation.id, { funnelState: translated ? 'whatsapp_menu_topic' : 'whatsapp_menu_language',
          qualificationData: data, qualificationStatus: 'pending', nextPrompt: prompt, promptOptions: options,
          nextStep: translated ? 'whatsapp_menu_topic' : 'whatsapp_menu_language', questionsAsked: 0, expectedUpdatedAt: conversation.updated_at }, prompt);
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
