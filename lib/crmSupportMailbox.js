import nodemailer from 'nodemailer';
import {readCrmImapConfig} from './crmImapInbound.js';
import {backendRuntime} from './backendRuntime.js';
export const SUPPORT_ADDRESS = 'support@padbol.com';
export const SUPPORT_ORIGIN = 'support_email';
// Existing Gustavo account currently used by coordination. No other role is granted.
export const CRM_SUPPORT_OPERATORS = Object.freeze([Object.freeze({email:'padbolinternacional@gmail.com',userId:'8beebdbe-e1d7-4607-9bb0-9a7d64701408'})]);
export function supportOperatorPermission({email,userId,role} = {}, operators = []) {
  return role === 'super_admin' && operators.some(actor=>actor.email === String(email || '').trim().toLowerCase() && actor.userId === userId);
}
export function isSupportConversation(conversation) {
  return conversation?.source_channel === 'email' && conversation?.origin === SUPPORT_ORIGIN && conversation?.qualification_data?.mailbox?.address === SUPPORT_ADDRESS;
}
export function readCrmSupportImapConfig(env = process.env) {
  const mapped = {};
  for (const [key,value] of Object.entries(env)) if (key.startsWith('CRM_SUPPORT_IMAP_')) mapped[key.replace('CRM_SUPPORT_IMAP_', 'CRM_INBOUND_IMAP_')] = value;
  mapped.CRM_INBOUND_IMAP_EXPECTED_RECIPIENT = SUPPORT_ADDRESS;
  const config = readCrmImapConfig(mapped);
  // Separate account and event namespace. Never reuse info@ or commercial settings.
  return {...config, enabled:config.enabled && backendRuntime(env).mode === 'production', ready: config.ready && config.user === SUPPORT_ADDRESS && config.secure && config.port === 993,
    source: 'support_email', origin: SUPPORT_ORIGIN, readOnly: true, redactErrors: true,
    qualificationData: {routing: {workflow: 'support'}, mailbox: {address: SUPPORT_ADDRESS}}};
}
export function readCrmSupportSmtpConfig(env = process.env, runtime = backendRuntime(env)) {
  const host = String(env.CRM_SUPPORT_SMTP_HOST || '').trim();
  const user = String(env.CRM_SUPPORT_SMTP_USER || '').trim().toLowerCase();
  const password = String(env.CRM_SUPPORT_SMTP_PASSWORD || '');
  const ready = Boolean(host && user === SUPPORT_ADDRESS && password && String(env.CRM_SUPPORT_SMTP_PORT || '465') === '465');
  return {host,port:465,secure:true,user,password,ready,enabled:ready && runtime.mode === 'production' && runtime.outboundDeliveryEnabled && env.CRM_SUPPORT_SMTP_ENABLED === 'true'};
}
export function createCrmSupportSender({env = process.env,runtime = backendRuntime(env),createTransport = nodemailer.createTransport} = {}) {
  const config = readCrmSupportSmtpConfig(env,runtime);
  if (!config.enabled) return null;
  const transport = createTransport({host:config.host,port:config.port,secure:true,auth:{user:config.user,pass:config.password},
    tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true,
    connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000});
  return async ({conversation,body,replyId}) => {
    if (!isSupportConversation(conversation)) throw Object.assign(new Error('La conversación no pertenece al buzón de soporte.'),{status:403,code:'CRM_SUPPORT_SCOPE_REQUIRED'});
    const to = String(conversation.contact?.email_normalized || '');
    if (!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(to) || !/^[a-zA-Z0-9-]{1,80}$/.test(String(replyId || '')) || !String(body || '').trim()) throw Object.assign(new Error('Respuesta de soporte inválida.'),{status:400,code:'CRM_EMAIL_REPLY_INVALID'});
    try {
      const result = await transport.sendMail({from:`Padbol Soporte <${SUPPORT_ADDRESS}>`,to,replyTo:SUPPORT_ADDRESS,
        messageId:`<crm-support-${replyId}@padbol.com>`,subject:('Re: '+String(conversation.subject || 'Tu consulta a Padbol')).replace(/[\r\n]/g,' ').slice(0,240),text:String(body).trim(),disableFileAccess:true,disableUrlAccess:true});
      if (!result?.messageId || !Array.isArray(result.accepted) || !result.accepted.some(address=>String(address).toLowerCase()===to.toLowerCase())) throw new Error('Not accepted');
      return {providerMessageId:result.messageId};
    } catch { throw Object.assign(new Error('No se pudo confirmar el envío de soporte. Revisa el historial antes de volver a intentar.'),{status:503,code:'CRM_EMAIL_SEND_UNCONFIRMED'}); }
  };
}
export function routeCrmEmailSender({commercialSender,supportSender} = {}) {
  if (!commercialSender && !supportSender) return null;
  const sender = async context => {
    const support = isSupportConversation(context?.conversation);
    // Fail closed even for malformed support metadata; never leak it to the commercial provider.
    const sender = context?.conversation?.origin === SUPPORT_ORIGIN ? (support ? supportSender : null) : commercialSender;
    if (typeof sender !== 'function') throw Object.assign(new Error('El canal de respuesta de esta conversación no está habilitado.'),{status:503,code:'CRM_EMAIL_CHANNEL_UNAVAILABLE'});
    return sender(context);
  };
  sender.channelCapabilities = Object.freeze({commercial:typeof commercialSender === 'function',support:typeof supportSender === 'function'});
  return sender;
}
