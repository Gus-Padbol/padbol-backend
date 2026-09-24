import {
  CRM_CLUB_ORGANIZATION_TYPE,
  CRM_QUALIFIED_HANDOFF_MESSAGE,
  clubFollowUpForQualification,
} from './crmService.js';

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
export function createCrmFunnel({ crmService, paths = [] } = {}) {
  const configuredPaths = parseCrmFunnelPaths(paths);
  if (!crmService) throw new Error('CRM funnel service is required');

  async function persist(conversationId, state, response) {
    const conversation = await crmService.recordQualificationProgress({ conversationId, ...state });
    await crmService.createPendingReply({ conversationId, body: response, operador: 'crm_funnel' });
    return { conversation, response };
  }

  return {
    get configured() { return configuredPaths.length > 0; },

    async ingestWhatsapp({ providerMessageId, phoneNumberId, fromWaId, body, textBody, receivedAt } = {}) {
      const inboundBody = body ?? textBody;
      const ingested = await crmService.ingestInbound({
        source: 'whatsapp_cloud', sourceId: providerMessageId, channel: 'whatsapp',
        phone: fromWaId, identityUsed: fromWaId, origin: `whatsapp:${phoneNumberId}`,
        body: inboundBody, receivedAt,
      });
      const conversation = ingested.conversation;
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
