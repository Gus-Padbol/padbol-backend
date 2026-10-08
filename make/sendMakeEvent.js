import { backendRuntime } from '../lib/backendRuntime.js';
/**
 * Webhook secundario para automatizaciones en Make.
 * Nunca interrumpe el flujo principal ante error o ausencia de configuración.
 */
export async function sendMakeEvent(eventType, data = {}) {
  if (!backendRuntime().outboundDeliveryEnabled) return { disabled: true };
  const webhookUrl = String(process.env.MAKE_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    console.warn('⚠️ MAKE_WEBHOOK_URL no configurada; evento omitido:', eventType);
    return;
  }

  const event = String(eventType || '').trim();
  if (!event) {
    console.warn('⚠️ sendMakeEvent sin eventType; evento omitido');
    return;
  }

  const payload =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { event, timestamp: new Date().toISOString(), ...data }
      : { event, timestamp: new Date().toISOString() };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.warn(`⚠️ Make webhook respondió ${resp.status} para evento "${event}"`);
    }
  } catch (err) {
    console.warn(`⚠️ Error enviando evento "${event}" a Make:`, err?.message || err);
  }
}
