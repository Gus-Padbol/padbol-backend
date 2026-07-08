import {
  PADCOINS_CAMPAIGN_AUDIT_ACTIONS,
  PADCOINS_CAMPAIGN_HIGH_IMPACT_THRESHOLDS,
  PADCOINS_CAMPAIGN_SELECT,
  PADCOINS_CAMPAIGN_STATUSES,
  PADCOINS_CAMPAIGN_TYPES,
} from './padcoinsCampaignsConfig.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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

function parseOptionalPositiveInt(raw, fieldName) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw buildHttpError(`${fieldName} debe ser un entero positivo o null`);
  }
  return parsed;
}

function parseOptionalNonNegativeInt(raw, fieldName) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw buildHttpError(`${fieldName} debe ser un entero >= 0 o null`);
  }
  return parsed;
}

function parseOptionalMultiplier(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw buildHttpError('multiplier debe ser un número >= 0');
  }
  return parsed;
}

function parseIsoDate(raw, fieldName) {
  if (raw == null || raw === '') {
    throw buildHttpError(`${fieldName} es obligatorio`);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw buildHttpError(`${fieldName} inválido`);
  }
  return date.toISOString();
}

function normalizeSegmentConfig(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw buildHttpError('segment_config debe ser un objeto');
  }
  return raw;
}

export function canReadPadcoinsCampaign(role, sedeId) {
  if (!role) return false;
  if (role.rol === 'super_admin') return true;
  if (role.rol === 'admin_club') {
    if (role.sede_id == null) return false;
    return Number(role.sede_id) === Number(sedeId);
  }
  return false;
}

export function canWritePadcoinsCampaign(role, sedeId) {
  return canReadPadcoinsCampaign(role, sedeId);
}

export function evaluateCampaignHighImpact(campaign) {
  const reasons = [];

  if (campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.MULTIPLIER) {
    const mult = Number(campaign.multiplier);
    if (Number.isFinite(mult) && mult >= PADCOINS_CAMPAIGN_HIGH_IMPACT_THRESHOLDS.multiplier) {
      reasons.push('multiplier_alto');
    }
  }

  if (campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.PERCENTAGE_OVERRIDE) {
    const pct = Number(campaign.loyalty_percentage_override);
    if (Number.isFinite(pct) && pct >= PADCOINS_CAMPAIGN_HIGH_IMPACT_THRESHOLDS.loyalty_percentage_override) {
      reasons.push('porcentaje_alto');
    }
  }

  if (campaign.campaign_type === PADCOINS_CAMPAIGN_TYPES.FIXED_PADCOINS) {
    const fixed = Number(campaign.fixed_padcoins);
    if (Number.isFinite(fixed) && fixed >= PADCOINS_CAMPAIGN_HIGH_IMPACT_THRESHOLDS.fixed_padcoins) {
      reasons.push('fixed_padcoins_alto');
    }
  }

  const estimated = Number(campaign.estimated_cost_reference);
  if (Number.isFinite(estimated) && estimated >= PADCOINS_CAMPAIGN_HIGH_IMPACT_THRESHOLDS.estimated_cost_reference) {
    reasons.push('costo_estimado_alto');
  }

  return {
    high_impact: reasons.length > 0,
    reasons,
  };
}

function validateCampaignTypeFields(campaignType, fields, { partial = false } = {}) {
  const required = (value, name) => {
    if (partial && value === undefined) return;
    if (value == null || value === '') {
      throw buildHttpError(`${name} es obligatorio para campaign_type=${campaignType}`);
    }
  };

  if (campaignType === PADCOINS_CAMPAIGN_TYPES.MULTIPLIER) {
    required(fields.multiplier, 'multiplier');
    if (fields.multiplier != null && Number(fields.multiplier) <= 0) {
      throw buildHttpError('multiplier debe ser > 0 para campañas multiplicadoras');
    }
  }

  if (campaignType === PADCOINS_CAMPAIGN_TYPES.PERCENTAGE_OVERRIDE) {
    required(fields.loyalty_percentage_override, 'loyalty_percentage_override');
    if (fields.loyalty_percentage_override != null && Number(fields.loyalty_percentage_override) <= 0) {
      throw buildHttpError('loyalty_percentage_override debe ser > 0');
    }
  }

  if (campaignType === PADCOINS_CAMPAIGN_TYPES.FIXED_PADCOINS) {
    required(fields.fixed_padcoins, 'fixed_padcoins');
    if (fields.fixed_padcoins != null && Number(fields.fixed_padcoins) <= 0) {
      throw buildHttpError('fixed_padcoins debe ser > 0');
    }
  }

  if (campaignType === PADCOINS_CAMPAIGN_TYPES.BENEFIT_EQUIVALENT) {
    required(fields.benefit_id, 'benefit_id');
    if (fields.benefit_id != null && !UUID_REGEX.test(String(fields.benefit_id))) {
      throw buildHttpError('benefit_id inválido');
    }
  }
}

function normalizeCampaignRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sede_id: Number(row.sede_id),
    name: row.name,
    description: row.description ?? null,
    campaign_type: row.campaign_type,
    start_at: row.start_at,
    end_at: row.end_at,
    status: row.status,
    multiplier: row.multiplier != null ? Number(row.multiplier) : null,
    loyalty_percentage_override: row.loyalty_percentage_override != null
      ? Number(row.loyalty_percentage_override)
      : null,
    fixed_padcoins: row.fixed_padcoins != null ? Number(row.fixed_padcoins) : null,
    benefit_id: row.benefit_id ?? null,
    max_total_uses: row.max_total_uses != null ? Number(row.max_total_uses) : null,
    max_uses_per_player: row.max_uses_per_player != null ? Number(row.max_uses_per_player) : null,
    estimated_cost_reference: row.estimated_cost_reference != null
      ? Number(row.estimated_cost_reference)
      : null,
    high_impact: row.high_impact === true,
    message_title: row.message_title ?? null,
    message_body: row.message_body ?? null,
    segment_config: row.segment_config ?? {},
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export async function appendCampaignAuditLog(supabaseAdmin, {
  campaign_id,
  sede_id,
  action,
  actor_user_id = null,
  actor_role = null,
  details = {},
  high_impact = false,
} = {}) {
  const payload = {
    campaign_id,
    sede_id,
    action,
    actor_user_id,
    actor_role,
    details,
    high_impact: high_impact === true,
  };

  const { data, error } = await supabaseAdmin
    .from('padcoins_campaign_audit_logs')
    .insert(payload)
    .select('id, action, high_impact, created_at')
    .single();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  return data;
}

async function assertBenefitBelongsToSede(supabaseAdmin, benefitId, sedeId) {
  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .select('id, sede_id, costo_padcoins, activo')
    .eq('id', benefitId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw buildHttpError('benefit_id no encontrado', 404);
  }
  if (Number(data.sede_id) !== Number(sedeId)) {
    throw buildHttpError('benefit_id no pertenece a la sede de la campaña', 400);
  }
  return data;
}

function buildCampaignPayloadFromInput(raw, { sedeId, createdBy, existing = null } = {}) {
  const campaignType = raw.campaign_type ?? existing?.campaign_type;
  if (!campaignType || !Object.values(PADCOINS_CAMPAIGN_TYPES).includes(campaignType)) {
    throw buildHttpError('campaign_type inválido');
  }

  const startAt = raw.start_at != null
    ? parseIsoDate(raw.start_at, 'start_at')
    : existing?.start_at;
  const endAt = raw.end_at != null
    ? parseIsoDate(raw.end_at, 'end_at')
    : existing?.end_at;

  if (startAt && endAt && new Date(endAt) <= new Date(startAt)) {
    throw buildHttpError('end_at debe ser posterior a start_at');
  }

  const fields = {
    multiplier: raw.multiplier !== undefined ? parseOptionalMultiplier(raw.multiplier) : existing?.multiplier,
    loyalty_percentage_override: raw.loyalty_percentage_override !== undefined
      ? parseOptionalNonNegativeInt(raw.loyalty_percentage_override, 'loyalty_percentage_override')
      : existing?.loyalty_percentage_override,
    fixed_padcoins: raw.fixed_padcoins !== undefined
      ? parseOptionalNonNegativeInt(raw.fixed_padcoins, 'fixed_padcoins')
      : existing?.fixed_padcoins,
    benefit_id: raw.benefit_id !== undefined ? raw.benefit_id : existing?.benefit_id,
  };

  validateCampaignTypeFields(campaignType, fields, { partial: Boolean(existing) });

  const draft = {
    sede_id: sedeId,
    name: raw.name != null ? String(raw.name).trim() : existing?.name,
    description: raw.description !== undefined
      ? (raw.description != null ? String(raw.description).trim() || null : null)
      : existing?.description,
    campaign_type: campaignType,
    start_at: startAt,
    end_at: endAt,
    status: existing?.status ?? PADCOINS_CAMPAIGN_STATUSES.DRAFT,
    multiplier: fields.multiplier,
    loyalty_percentage_override: fields.loyalty_percentage_override,
    fixed_padcoins: fields.fixed_padcoins,
    benefit_id: fields.benefit_id ?? null,
    max_total_uses: raw.max_total_uses !== undefined
      ? parseOptionalPositiveInt(raw.max_total_uses, 'max_total_uses')
      : existing?.max_total_uses,
    max_uses_per_player: raw.max_uses_per_player !== undefined
      ? parseOptionalPositiveInt(raw.max_uses_per_player, 'max_uses_per_player')
      : existing?.max_uses_per_player,
    estimated_cost_reference: raw.estimated_cost_reference !== undefined
      ? parseOptionalNonNegativeInt(raw.estimated_cost_reference, 'estimated_cost_reference')
      : existing?.estimated_cost_reference,
    message_title: raw.message_title !== undefined
      ? (raw.message_title != null ? String(raw.message_title).trim() || null : null)
      : existing?.message_title,
    message_body: raw.message_body !== undefined
      ? (raw.message_body != null ? String(raw.message_body).trim() || null : null)
      : existing?.message_body,
    segment_config: raw.segment_config !== undefined
      ? normalizeSegmentConfig(raw.segment_config)
      : (existing?.segment_config ?? {}),
    created_by: existing?.created_by ?? createdBy ?? null,
    updated_at: new Date().toISOString(),
  };

  if (!draft.name) {
    throw buildHttpError('name es obligatorio');
  }

  const impact = evaluateCampaignHighImpact(draft);
  draft.high_impact = impact.high_impact;

  return { payload: draft, impact };
}

export async function listPadcoinsCampaigns(supabaseAdmin, { role, query = {} } = {}) {
  if (!role || (role.rol !== 'super_admin' && role.rol !== 'admin_club')) {
    throw buildHttpError('No tenés permiso para listar campañas PadCoins', 403);
  }

  let sedeFilter = null;
  if (role.rol === 'admin_club') {
    sedeFilter = parseSedeId(role.sede_id);
    if (!sedeFilter) {
      throw buildHttpError('Admin de club sin sede asignada', 403);
    }
  } else if (query.sede_id != null && query.sede_id !== '') {
    sedeFilter = parseSedeId(query.sede_id);
    if (!sedeFilter) throw buildHttpError('sede_id inválido');
  }

  let dbQuery = supabaseAdmin
    .from('padcoins_campaigns')
    .select(PADCOINS_CAMPAIGN_SELECT)
    .order('created_at', { ascending: false });

  if (sedeFilter) dbQuery = dbQuery.eq('sede_id', sedeFilter);
  if (query.status) dbQuery = dbQuery.eq('status', String(query.status).trim());

  const { data, error } = await dbQuery;

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  return (data ?? []).map(normalizeCampaignRow);
}

export async function getPadcoinsCampaignById(supabaseAdmin, campaignId) {
  const id = String(campaignId ?? '').trim();
  if (!UUID_REGEX.test(id)) {
    throw buildHttpError('campaign id inválido');
  }

  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .select(PADCOINS_CAMPAIGN_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      throw buildHttpError('Tabla padcoins_campaigns no existe. Ejecutá la migración SQL primero.', 503);
    }
    throw error;
  }

  if (!data) throw buildHttpError('Campaña no encontrada', 404);
  return normalizeCampaignRow(data);
}

export async function createPadcoinsCampaign(supabaseAdmin, {
  role,
  body,
  actor_user_id,
} = {}) {
  const sedeId = parseSedeId(body?.sede_id);
  if (!sedeId) throw buildHttpError('sede_id inválido');

  if (!canWritePadcoinsCampaign(role, sedeId)) {
    throw buildHttpError('No tenés permiso para crear campañas en esta sede', 403);
  }

  const { payload, impact } = buildCampaignPayloadFromInput(body, {
    sedeId,
    createdBy: actor_user_id,
  });

  if (payload.campaign_type === PADCOINS_CAMPAIGN_TYPES.BENEFIT_EQUIVALENT) {
    await assertBenefitBelongsToSede(supabaseAdmin, payload.benefit_id, sedeId);
  }

  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .insert(payload)
    .select(PADCOINS_CAMPAIGN_SELECT)
    .single();

  if (error) {
    if (isMissingTable(error)) {
      throw buildHttpError('Tabla padcoins_campaigns no existe. Ejecutá la migración SQL primero.', 503);
    }
    throw error;
  }

  const campaign = normalizeCampaignRow(data);

  await appendCampaignAuditLog(supabaseAdmin, {
    campaign_id: campaign.id,
    sede_id: campaign.sede_id,
    action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.CREATED,
    actor_user_id,
    actor_role: role?.rol ?? null,
    details: { campaign_type: campaign.campaign_type, high_impact_reasons: impact.reasons },
    high_impact: campaign.high_impact,
  });

  if (campaign.high_impact) {
    await appendCampaignAuditLog(supabaseAdmin, {
      campaign_id: campaign.id,
      sede_id: campaign.sede_id,
      action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.HIGH_IMPACT_FLAGGED,
      actor_user_id,
      actor_role: role?.rol ?? null,
      details: { reasons: impact.reasons },
      high_impact: true,
    });
  }

  return campaign;
}

export async function updatePadcoinsCampaign(supabaseAdmin, campaignId, {
  role,
  body,
  actor_user_id,
} = {}) {
  const existing = await getPadcoinsCampaignById(supabaseAdmin, campaignId);

  if (!canWritePadcoinsCampaign(role, existing.sede_id)) {
    throw buildHttpError('No tenés permiso para editar esta campaña', 403);
  }

  if (existing.status === PADCOINS_CAMPAIGN_STATUSES.ENDED) {
    throw buildHttpError('No se puede editar una campaña finalizada', 400);
  }

  const { payload, impact } = buildCampaignPayloadFromInput(body, {
    sedeId: existing.sede_id,
    createdBy: existing.created_by,
    existing,
  });

  if (payload.campaign_type === PADCOINS_CAMPAIGN_TYPES.BENEFIT_EQUIVALENT) {
    await assertBenefitBelongsToSede(supabaseAdmin, payload.benefit_id, existing.sede_id);
  }

  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .update(payload)
    .eq('id', existing.id)
    .select(PADCOINS_CAMPAIGN_SELECT)
    .single();

  if (error) throw error;

  const campaign = normalizeCampaignRow(data);

  await appendCampaignAuditLog(supabaseAdmin, {
    campaign_id: campaign.id,
    sede_id: campaign.sede_id,
    action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.UPDATED,
    actor_user_id,
    actor_role: role?.rol ?? null,
    details: { high_impact_reasons: impact.reasons },
    high_impact: campaign.high_impact,
  });

  return campaign;
}

async function pauseOtherActiveCampaigns(supabaseAdmin, sedeId, exceptCampaignId, actor) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .select('id')
    .eq('sede_id', sedeId)
    .eq('status', PADCOINS_CAMPAIGN_STATUSES.ACTIVE)
    .neq('id', exceptCampaignId);

  if (error) {
    if (isMissingTable(error)) return;
    throw error;
  }

  for (const row of data ?? []) {
    await supabaseAdmin
      .from('padcoins_campaigns')
      .update({
        status: PADCOINS_CAMPAIGN_STATUSES.PAUSED,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    await appendCampaignAuditLog(supabaseAdmin, {
      campaign_id: row.id,
      sede_id: sedeId,
      action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.PAUSED,
      actor_user_id: actor.actor_user_id,
      actor_role: actor.actor_role,
      details: { reason: 'otra_campana_activada', replaced_by: exceptCampaignId },
      high_impact: false,
    });
  }
}

export async function activatePadcoinsCampaign(supabaseAdmin, campaignId, {
  role,
  actor_user_id,
} = {}) {
  const existing = await getPadcoinsCampaignById(supabaseAdmin, campaignId);

  if (!canWritePadcoinsCampaign(role, existing.sede_id)) {
    throw buildHttpError('No tenés permiso para activar esta campaña', 403);
  }

  if (!existing.sede_id) {
    throw buildHttpError('Campaña sin sede_id', 400);
  }

  if (existing.status === PADCOINS_CAMPAIGN_STATUSES.ACTIVE) {
    return existing;
  }

  if (existing.status === PADCOINS_CAMPAIGN_STATUSES.ENDED) {
    throw buildHttpError('No se puede activar una campaña finalizada', 400);
  }

  const now = new Date();
  if (new Date(existing.end_at) <= now) {
    throw buildHttpError('No se puede activar: la campaña ya finalizó (end_at)', 400);
  }

  validateCampaignTypeFields(existing.campaign_type, existing);

  await pauseOtherActiveCampaigns(supabaseAdmin, existing.sede_id, existing.id, {
    actor_user_id,
    actor_role: role?.rol ?? null,
  });

  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .update({
      status: PADCOINS_CAMPAIGN_STATUSES.ACTIVE,
      updated_at: now.toISOString(),
    })
    .eq('id', existing.id)
    .select(PADCOINS_CAMPAIGN_SELECT)
    .single();

  if (error) throw error;

  const campaign = normalizeCampaignRow(data);

  await appendCampaignAuditLog(supabaseAdmin, {
    campaign_id: campaign.id,
    sede_id: campaign.sede_id,
    action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.ACTIVATED,
    actor_user_id,
    actor_role: role?.rol ?? null,
    details: { high_impact: campaign.high_impact },
    high_impact: campaign.high_impact,
  });

  if (campaign.high_impact) {
    await appendCampaignAuditLog(supabaseAdmin, {
      campaign_id: campaign.id,
      sede_id: campaign.sede_id,
      action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.HIGH_IMPACT_FLAGGED,
      actor_user_id,
      actor_role: role?.rol ?? null,
      details: { phase: 'activation' },
      high_impact: true,
    });
  }

  return campaign;
}

export async function pausePadcoinsCampaign(supabaseAdmin, campaignId, {
  role,
  actor_user_id,
} = {}) {
  const existing = await getPadcoinsCampaignById(supabaseAdmin, campaignId);

  if (!canWritePadcoinsCampaign(role, existing.sede_id)) {
    throw buildHttpError('No tenés permiso para pausar esta campaña', 403);
  }

  if (existing.status !== PADCOINS_CAMPAIGN_STATUSES.ACTIVE) {
    return existing;
  }

  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .update({
      status: PADCOINS_CAMPAIGN_STATUSES.PAUSED,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select(PADCOINS_CAMPAIGN_SELECT)
    .single();

  if (error) throw error;

  const campaign = normalizeCampaignRow(data);

  await appendCampaignAuditLog(supabaseAdmin, {
    campaign_id: campaign.id,
    sede_id: campaign.sede_id,
    action: PADCOINS_CAMPAIGN_AUDIT_ACTIONS.PAUSED,
    actor_user_id,
    actor_role: role?.rol ?? null,
    details: {},
    high_impact: false,
  });

  return campaign;
}

export async function getPadcoinsCampaignSummary(supabaseAdmin, campaignId, { role } = {}) {
  const campaign = await getPadcoinsCampaignById(supabaseAdmin, campaignId);

  if (!canReadPadcoinsCampaign(role, campaign.sede_id)) {
    throw buildHttpError('No tenés permiso para ver el resumen de esta campaña', 403);
  }

  const { count: totalApplications, error: countError } = await supabaseAdmin
    .from('padcoins_campaign_applications')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id);

  if (countError && !isMissingTable(countError)) throw countError;

  const { data: sums, error: sumError } = await supabaseAdmin
    .from('padcoins_campaign_applications')
    .select('base_padcoins, final_padcoins')
    .eq('campaign_id', campaign.id);

  if (sumError && !isMissingTable(sumError)) throw sumError;

  const rows = sums ?? [];
  const totalBase = rows.reduce((acc, row) => acc + Number(row.base_padcoins ?? 0), 0);
  const totalFinal = rows.reduce((acc, row) => acc + Number(row.final_padcoins ?? 0), 0);

  const { data: auditRows, error: auditError } = await supabaseAdmin
    .from('padcoins_campaign_audit_logs')
    .select('id, action, high_impact, created_at')
    .eq('campaign_id', campaign.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (auditError && !isMissingTable(auditError)) throw auditError;

  return {
    campaign,
    summary: {
      total_applications: totalApplications ?? rows.length,
      total_base_padcoins: totalBase,
      total_final_padcoins: totalFinal,
      bonus_padcoins: Math.max(0, totalFinal - totalBase),
      remaining_total_uses: campaign.max_total_uses != null
        ? Math.max(0, campaign.max_total_uses - (totalApplications ?? rows.length))
        : null,
      high_impact: campaign.high_impact,
    },
    recent_audit: auditRows ?? [],
  };
}
