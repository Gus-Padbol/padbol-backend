import { PADCOINS_CAMPAIGN_TYPES } from './padcoinsCampaignsConfig.js';
import { resolveActiveCampaignForReserva } from './padcoinsCampaignResolverService.js';
import { isPadcoinsActiveForSede } from './padcoinsSedeConfigService.js';

const PLAYER_CAMPAIGN_SELECT = [
  'id',
  'sede_id',
  'name',
  'description',
  'campaign_type',
  'start_at',
  'end_at',
  'message_title',
  'message_body',
  'multiplier',
].join(', ');

const DEFAULT_DISPLAY = {
  banner_title: 'Campaña PadCoins activa',
  banner_text: 'Esta sede tiene una campaña especial por tiempo limitado.',
  reservation_hint: 'Al confirmar esta reserva puedes sumar PadCoins extra por la campaña activa de esta sede.',
  success_hint: 'Si cumple las condiciones de la campaña, los PadCoins extra se acreditarán automáticamente.',
};

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

/**
 * Label amigable por tipo de campaña (sin equivalencias monetarias).
 */
export function buildCampaignTypeLabel(campaign) {
  const type = campaign?.campaign_type;

  if (type === PADCOINS_CAMPAIGN_TYPES.MULTIPLIER) {
    const mult = Number(campaign?.multiplier);
    if (mult === 2) return 'Duplica PadCoins';
    if (mult === 3) return 'Triplica PadCoins';
    return 'Multiplica PadCoins';
  }

  if (type === PADCOINS_CAMPAIGN_TYPES.PERCENTAGE_OVERRIDE) {
    return 'PadCoins extra';
  }

  if (type === PADCOINS_CAMPAIGN_TYPES.FIXED_PADCOINS) {
    return 'PadCoins extra';
  }

  if (type === PADCOINS_CAMPAIGN_TYPES.BENEFIT_EQUIVALENT) {
    return 'Beneficio especial';
  }

  return 'Campaña PadCoins';
}

export function buildPlayerCampaignDisplay(campaign) {
  const label = buildCampaignTypeLabel(campaign);
  const bannerTitle = campaign?.message_title?.trim() || DEFAULT_DISPLAY.banner_title;
  const bannerText = campaign?.message_body?.trim() || DEFAULT_DISPLAY.banner_text;

  return {
    banner_title: bannerTitle,
    banner_text: bannerText,
    reservation_hint: DEFAULT_DISPLAY.reservation_hint,
    success_hint: DEFAULT_DISPLAY.success_hint,
    label,
  };
}

/**
 * Payload seguro para jugador — sin campos internos ni costos.
 */
export function buildPlayerCampaignPayload(campaign) {
  if (!campaign) return null;

  const display = buildPlayerCampaignDisplay(campaign);

  return {
    id: campaign.id,
    sede_id: Number(campaign.sede_id),
    name: campaign.name,
    description: campaign.description ?? null,
    campaign_type: campaign.campaign_type,
    start_at: campaign.start_at,
    end_at: campaign.end_at,
    label: display.label,
    message_title: campaign.message_title ?? null,
    message_body: campaign.message_body ?? null,
    display: {
      banner_title: display.banner_title,
      banner_text: display.banner_text,
      reservation_hint: display.reservation_hint,
      success_hint: display.success_hint,
    },
  };
}

async function fetchPlayerCampaignRow(supabaseAdmin, campaignId) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .select(PLAYER_CAMPAIGN_SELECT)
    .eq('id', campaignId)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  return data ?? null;
}

/**
 * Campaña activa visible para jugador en una sede.
 * Reutiliza resolveActiveCampaignForReserva (fechas, status, cupos).
 */
export async function getActiveCampaignForSedePlayer(supabaseAdmin, sedeId, {
  userId = null,
  now = new Date(),
} = {}) {
  const sid = parseSedeId(sedeId);
  if (!sid) {
    const err = new Error('sede_id inválido');
    err.status = 400;
    throw err;
  }

  const participa = await isPadcoinsActiveForSede(supabaseAdmin, sid, { now });
  if (!participa) {
    return { active: false, campaign: null };
  }

  const resolved = await resolveActiveCampaignForReserva(supabaseAdmin, {
    sedeId: sid,
    userId,
    now,
  });

  if (!resolved) {
    return { active: false, campaign: null };
  }

  const row = await fetchPlayerCampaignRow(supabaseAdmin, resolved.id);
  if (!row || Number(row.sede_id) !== sid) {
    return { active: false, campaign: null };
  }

  return {
    active: true,
    campaign: buildPlayerCampaignPayload(row),
  };
}

export { PLAYER_CAMPAIGN_SELECT, DEFAULT_DISPLAY };
