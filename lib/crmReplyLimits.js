// Email counts PostgreSQL Unicode code points. WhatsApp preserves its existing
// sender UTF-16 ceiling; this change does not widen its delivery contract.
export const CRM_EMAIL_REPLY_MAX = 16384;
export const CRM_WHATSAPP_REPLY_MAX = 4096;
export const crmReplyLimit = channel => channel === 'email' ? CRM_EMAIL_REPLY_MAX : channel === 'whatsapp' ? CRM_WHATSAPP_REPLY_MAX : null;
export const crmReplyLength = (text,channel = 'email') => channel === 'whatsapp' ? text.trim().length : Array.from(text.trim()).length;
