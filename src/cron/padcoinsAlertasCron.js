import { evaluarAlertasPadcoinsGlobal } from '../padcoins/padcoinsAlertsService.js';
import {
  getPadcoinsAlertasDigestCronExpression,
  sendPadcoinsAlertasWhatsAppDigest,
  shouldSendPadcoinsAlertDigest,
} from '../padcoins/padcoinsAlertasDigestService.js';
import {
  sendPadcoinsAlertasPushDigest,
  shouldSendPadcoinsAlertasPushDigest,
} from '../padcoins/padcoinsAlertasPushDigestService.js';

const TZ_DEFAULT = 'America/Argentina/Buenos_Aires';

function buildTwilioSendFn(twilioClient, twilioFrom) {
  if (!twilioClient || typeof twilioClient.messages?.create !== 'function') {
    return null;
  }

  const from = twilioFrom ?? process.env.TWILIO_WHATSAPP_FROM ?? 'whatsapp:+14155238886';

  return async ({ to, body, from: fromOverride }) => {
    await twilioClient.messages.create({
      from: fromOverride ?? from,
      to,
      body,
    });
  };
}

function describeActiveChannels() {
  const channels = [];
  if (shouldSendPadcoinsAlertasPushDigest()) channels.push('push');
  if (shouldSendPadcoinsAlertDigest()) channels.push('WhatsApp');
  return channels;
}

export async function runPadcoinsAlertasDigestJob({
  supabaseAdmin,
  twilioClient,
  twilioFrom,
  legacySuperAdminEmails = [],
} = {}) {
  const pushEnabled = shouldSendPadcoinsAlertasPushDigest();
  const whatsappEnabled = shouldSendPadcoinsAlertDigest();

  if (!pushEnabled && !whatsappEnabled) {
    return { ok: true, skipped: true, reason: 'all_channels_disabled' };
  }

  let alertasRaw = [];
  try {
    alertasRaw = await evaluarAlertasPadcoinsGlobal(supabaseAdmin, {});
  } catch (err) {
    console.warn('⚠️ PadCoins alertas digest — evaluación falló:', err.message);
    return { ok: false, error: err.message };
  }

  const fetchAlertasFn = async () => alertasRaw;
  const results = { ok: true, alertas_evaluadas: alertasRaw.length };

  if (whatsappEnabled) {
    const sendWhatsAppMessage = buildTwilioSendFn(twilioClient, twilioFrom);
    results.whatsapp = await sendPadcoinsAlertasWhatsAppDigest({
      supabaseAdmin,
      sendWhatsAppMessage,
      twilioFrom,
      fetchAlertasFn,
    });
  }

  if (pushEnabled) {
    results.push = await sendPadcoinsAlertasPushDigest({
      supabaseAdmin,
      legacySuperAdminEmails,
      fetchAlertasFn,
    });
  }

  return results;
}

export function initPadcoinsAlertasCron({
  supabaseAdmin,
  cron,
  twilioClient,
  twilioFrom,
  legacySuperAdminEmails = [],
  timezone = TZ_DEFAULT,
} = {}) {
  if (!cron || typeof cron.schedule !== 'function') {
    console.warn('⚠️ Cron PadCoins alertas — node-cron no disponible');
    return;
  }

  const expression = getPadcoinsAlertasDigestCronExpression();
  const channels = describeActiveChannels();

  const run = async () => {
    try {
      await runPadcoinsAlertasDigestJob({
        supabaseAdmin,
        twilioClient,
        twilioFrom,
        legacySuperAdminEmails,
      });
    } catch (err) {
      console.error('❌ Cron PadCoins alertas digest — error inesperado:', err.message);
    }
  };

  cron.schedule(expression, run, { timezone });

  if (channels.length) {
    console.log(
      `⏰ Cron PadCoins alertas digest registrado (${expression}) — canales: ${channels.join(', ')}`,
    );
  } else {
    console.log(
      `⏰ Cron PadCoins alertas digest registrado (${expression}) — desactivado (push/WhatsApp off)`,
    );
  }
}
