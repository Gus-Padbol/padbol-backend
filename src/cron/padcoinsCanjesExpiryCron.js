import { expireDuePadcoinsCanjes } from '../padcoins/padcoinsCanjeExpiryService.js';

const TZ_DEFAULT = 'America/Argentina/Buenos_Aires';
const DEFAULT_CRON_EXPRESSION = '15 * * * *';

export function getPadcoinsCanjesExpiryCronExpression() {
  return process.env.PADCOINS_CANJES_EXPIRY_CRON?.trim() || DEFAULT_CRON_EXPRESSION;
}

export function isPadcoinsCanjesExpiryCronEnabled() {
  const raw = process.env.PADCOINS_CANJES_EXPIRY_CRON_ENABLED;
  if (raw == null || raw === '') return true;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export async function runPadcoinsCanjesExpiryJob({
  supabaseAdmin,
  batchSize = 100,
} = {}) {
  if (!supabaseAdmin) {
    return { ok: false, skipped: true, reason: 'no_supabase' };
  }

  const result = await expireDuePadcoinsCanjes(supabaseAdmin, { batchSize });
  return { ok: true, ...result };
}

export function initPadcoinsCanjesExpiryCron({
  supabaseAdmin,
  cron,
  timezone = TZ_DEFAULT,
} = {}) {
  if (!isPadcoinsCanjesExpiryCronEnabled()) {
    console.log('⏰ Cron PadCoins canjes vencidos — desactivado (PADCOINS_CANJES_EXPIRY_CRON_ENABLED=false)');
    return;
  }

  if (!cron || typeof cron.schedule !== 'function') {
    console.warn('⚠️ Cron PadCoins canjes vencidos — node-cron no disponible');
    return;
  }

  const expression = getPadcoinsCanjesExpiryCronExpression();

  cron.schedule(expression, async () => {
    try {
      const result = await runPadcoinsCanjesExpiryJob({ supabaseAdmin });
      if (result.vencidos > 0) {
        console.log(`⏰ Cron PadCoins canjes vencidos — ${result.vencidos}/${result.processed} procesado(s)`);
      }
    } catch (err) {
      console.error('❌ Cron PadCoins canjes vencidos — error:', err.message);
    }
  }, { timezone });

  console.log(`⏰ Cron PadCoins canjes vencidos registrado (${expression})`);
}
