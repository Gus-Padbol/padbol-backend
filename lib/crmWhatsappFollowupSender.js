// A single attempt only. The caller must atomically claim the step, recheck
// consent and approval, and record uncertain outcomes without retrying.
const WA_ID = /^\d{8,15}$/;
const PHONE_ID = /^\d{5,30}$/;
const VERSION = /^v\d{1,3}\.0$/;
const TEMPLATE = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;

export function buildFollowupTemplatePayload({to, name, language, parameters = []} = {}) {
  if (!WA_ID.test(String(to || '')) || !TEMPLATE.test(String(name || '')) || !LANGUAGE.test(String(language || '')) || !Array.isArray(parameters) || parameters.length > 10 || parameters.some(p => typeof p !== 'string' || !p.trim() || p.length > 1024)) throw new Error('WHATSAPP_FOLLOWUP_INVALID');
  return { messaging_product:'whatsapp', to, type:'template', template:{name,language:{code:language},...(parameters.length ? {components:[{type:'body',parameters:parameters.map(text => ({type:'text',text}))}]} : {})} };
}
export async function sendFollowupTemplate({phoneId, version, accessToken, payload, fetchImpl = globalThis.fetch, timeoutMs = 10000} = {}) {
  if (!PHONE_ID.test(String(phoneId || '')) || !VERSION.test(String(version || '')) || typeof accessToken !== 'string' || !accessToken.trim() || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('WHATSAPP_FOLLOWUP_CONFIG_INVALID');
  const safePayload = buildFollowupTemplatePayload({to:payload?.to,name:payload?.template?.name,language:payload?.template?.language?.code,parameters:payload?.template?.components?.[0]?.parameters?.map(p => p.text) || []});
  const controller = new AbortController(); let timer;
  try {
    const deadline = new Promise((_, reject) => {timer=setTimeout(()=>{controller.abort();reject(new Error('WHATSAPP_FOLLOWUP_UNCERTAIN'));},timeoutMs);});
    const operation = (async () => {
      const response = await fetchImpl(`https://graph.facebook.com/${version}/${phoneId}/messages`,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify(safePayload)});
      const body = await response.json();
      if (!response.ok || response.redirected || typeof body?.messages?.[0]?.id !== 'string' || !body.messages[0].id.trim()) throw new Error('WHATSAPP_FOLLOWUP_UNCERTAIN');
      return {providerMessageId:body.messages[0].id};
    })();
    return await Promise.race([operation, deadline]);
  } catch { throw new Error('WHATSAPP_FOLLOWUP_UNCERTAIN'); }
  finally {clearTimeout(timer);}
}
