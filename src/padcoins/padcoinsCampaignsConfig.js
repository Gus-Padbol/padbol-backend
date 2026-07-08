export const PADCOINS_CAMPAIGN_TYPES = Object.freeze({
  MULTIPLIER: 'multiplier',
  PERCENTAGE_OVERRIDE: 'percentage_override',
  FIXED_PADCOINS: 'fixed_padcoins',
  BENEFIT_EQUIVALENT: 'benefit_equivalent',
});

export const PADCOINS_CAMPAIGN_STATUSES = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED: 'ended',
});

export const PADCOINS_CAMPAIGN_AUDIT_ACTIONS = Object.freeze({
  CREATED: 'created',
  UPDATED: 'updated',
  ACTIVATED: 'activated',
  PAUSED: 'paused',
  APPLIED: 'applied',
  HIGH_IMPACT_FLAGGED: 'high_impact_flagged',
});

/** Umbrales para marcar high_impact (auditoría Super Admin; no bloquea). */
export const PADCOINS_CAMPAIGN_HIGH_IMPACT_THRESHOLDS = Object.freeze({
  multiplier: 2,
  loyalty_percentage_override: 15,
  fixed_padcoins: 500,
  estimated_cost_reference: 5000,
});

export const PADCOINS_CAMPAIGN_SELECT = [
  'id',
  'sede_id',
  'name',
  'description',
  'campaign_type',
  'start_at',
  'end_at',
  'status',
  'multiplier',
  'loyalty_percentage_override',
  'fixed_padcoins',
  'benefit_id',
  'max_total_uses',
  'max_uses_per_player',
  'estimated_cost_reference',
  'high_impact',
  'message_title',
  'message_body',
  'segment_config',
  'created_by',
  'created_at',
  'updated_at',
].join(', ');
