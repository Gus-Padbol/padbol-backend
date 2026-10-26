import {buildFollowupTemplatePayload,sendFollowupTemplate} from './crmWhatsappFollowupSender.js';
const PADBOL_PHONE_ID='1376102838911694';
// No automatic invocation. The caller must pass a server-owned allowlist whose
// approval was verified against the correct WABA. Never log credentials or PII.
export function createWelcomeMetaTransport({enabled=false,phoneId,version,accessToken,approvedTemplates,fetchImpl=globalThis.fetch}={}) {
 return {async sendApprovedTemplate({to,template,bodyParameters}) {
   if(enabled!==true || String(phoneId)!==PADBOL_PHONE_ID) throw Error('WELCOME_DISABLED');
   const approved=Array.isArray(approvedTemplates) && approvedTemplates.some(t=>t?.approved===true && t.name===template?.name && t.locale===template?.locale);
   if(!approved) throw Error('WELCOME_TEMPLATE_NOT_APPROVED');
   const payload=buildFollowupTemplatePayload({to:String(to).replace(/^\+/,''),name:template.name,language:template.locale,parameters:bodyParameters});
   const result=await sendFollowupTemplate({phoneId,version,accessToken,payload,fetchImpl});
   return {messageId:result.providerMessageId};
 }};
}
