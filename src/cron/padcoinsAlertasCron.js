import {
  getPadcoinsAlertasDigestCronExpression,
  sendPadcoinsAlertasWhatsAppDigest,
  shouldSendPadcoinsAlertDigest,
} from '../padcoins/padcoinsAlertasDigestService.js';

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

export async function runPadcoinsAlertasDigestJob({
  supabaseAdmin,
  twilioClient,
  twilioFrom,
} = {}) {
  const sendWhatsAppMessage = buildTwilioSendFn(twilioClient, twilioFrom);

  return sendPadcoinsAlertasWhatsAppDigest({
    supabaseAdmin,
    sendWhatsAppMessage,
    twilioFrom,
  });
}

export function initPadcoinsAlertasCron({
  supabaseAdmin,
  cron,
  twilioClient,
  twilioFrom,
  timezone = TZ_DEFAULT,
} = {}) {
  if (!cron || typeof cron.schedule !== 'function') {
    console.warn('⚠️ Cron PadCoins alertas — node-cron no disponible');
    return;
  }

  const expression = getPadcoinsAlertasDigestCronExpression();
  const enabled = shouldSendPadcoinsAlertDigest();

  const run = async () => {
    try {
      await runPadcoinsAlertasDigestJob({ supabaseAdmin, twilioClient, twilioFrom });
    } catch (err) {
      console.error('❌ Cron PadCoins alertas digest — error inesperado:', err.message);
    }
  };

  cron.schedule(expression, run, { timezone });

  if (enabled) {
    console.log(`⏰ Cron PadCoins alertas WhatsApp registrado (${expression})`);
  } else {
    console.log(
      `⏰ Cron PadCoins alertas WhatsApp registrado (${expression}) — desactivado (faltan env o enabled=false)`,
    );
  }
}
