import { validateAiChatRequest } from '../context/allowlist.js';
import { buildServerSideAiContext, buildUserPromptFromContext } from '../context/buildServerContext.js';
import { formatPromptVersion, resolvePromptForSkill } from '../prompts/registry.js';
import { getAiProvider } from '../providers/index.js';
import {
  logAiChatError,
  logAiChatStart,
  logAiChatSuccess,
} from '../audit/aiAuditLog.js';
import { AI_PUBLIC_ERROR } from '../constants.js';

export async function processAiChatRequest({
  user,
  body,
  pgPool = null,
  provider = getAiProvider(),
}) {
  const startedAt = Date.now();
  const { skill, message, params } = validateAiChatRequest(body);

  logAiChatStart({
    skill,
    userId: user?.id,
    messageLength: message.length,
  });

  try {
    const prompt = resolvePromptForSkill(skill);
    const serverContext = await buildServerSideAiContext({
      userId: user?.id,
      params,
      pgPool,
    });
    const userMessage = buildUserPromptFromContext(message, serverContext);

    const { reply, provider: providerName } = await provider.completeChat({
      system: prompt.system,
      userMessage,
      maxTokens: prompt.maxTokens,
    });

    const latencyMs = Date.now() - startedAt;
    const promptVersion = formatPromptVersion(prompt);

    logAiChatSuccess({
      skill,
      userId: user?.id,
      promptVersion,
      latencyMs,
    });

    return {
      reply,
      skill,
      prompt_version: promptVersion,
      provider: providerName,
    };
  } catch (err) {
    logAiChatError({
      skill,
      userId: user?.id,
      err,
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
}

export function buildAiChatErrorResponse(err) {
  const status = Number(err?.status);
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return {
      status,
      body: { ok: false, error: err.message },
      code: err.code,
    };
  }

  return {
    status: 500,
    body: { ok: false, error: AI_PUBLIC_ERROR },
    code: err?.code,
  };
}
