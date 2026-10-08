const RULE_METRICS = Object.freeze({
  torneos_integrales: ['torneos_minimos', 'torneos_finalizados'],
  jugadores_registrados: ['jugadores_registrados_minimos', 'jugadores_registrados_torneos'],
  marcador: ['partidos_marcador_minimos', 'partidos_marcador_finalizados'],
  reservas: ['reservas_minimas', 'reservas_validas'],
  jugadores_activos: ['jugadores_activos_minimos', 'jugadores_activos'],
  padcoins: ['movimientos_padcoins_minimos', 'movimientos_padcoins'],
});

const DEFAULT_RULES = Object.freeze({});

export const PADBOL_COURT_PRO_POLICY = Object.freeze({
  code: 'padbol_pro_renovable',
  version: 'pricing-v2',
  currency: 'USD',
  baseMonthlyUsd: 68,
  includedMonths: 3,
  padbolCourtMonthlyUsd: 34,
  objectivesMonthlyUsd: 17,
  billingEnabled: false,
});

export function normalizeIncentiveRules(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key] of Object.values(RULE_METRICS)) {
    const value = Number.parseInt(String(source[key] ?? ''), 10);
    if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

export function evaluateIncentiveMetrics(metrics = {}, rulesRaw = {}) {
  const rules = normalizeIncentiveRules(rulesRaw);
  const criteria = {};
  const details = {};
  for (const [criterion, [ruleKey, metricKey]] of Object.entries(RULE_METRICS)) {
    const target = rules[ruleKey] ?? null;
    const rawMetric = metrics?.[metricKey];
    const current = Number.isFinite(Number(rawMetric)) ? Math.max(0, Number(rawMetric)) : null;
    const configured = Number.isFinite(target) && target > 0;
    const met = configured && current != null ? current >= target : null;
    criteria[criterion] = met;
    details[criterion] = {
      rule_key: ruleKey,
      metric_key: metricKey,
      configured,
      current,
      target,
      state: !configured ? 'pending_configuration' : current == null ? 'unavailable' : met ? 'completed' : 'pending',
    };
  }
  const required = Object.keys(RULE_METRICS).length;
  const configuredCount = Object.values(details).filter((row) => row.configured).length;
  const completedCount = Object.values(details).filter((row) => row.state === 'completed').length;
  const configurationComplete = configuredCount === required;
  return {
    cumplido: configurationComplete ? completedCount === required : null,
    criterios: criteria,
    detalle_criterios: details,
    configuracion_completa: configurationComplete,
    criterios_configurados: configuredCount,
    criterios_cumplidos: completedCount,
    criterios_requeridos: required,
    objetivos_pendientes_configuracion: Object.values(details)
      .filter((row) => !row.configured)
      .map((row) => row.rule_key),
    rules,
  };
}

export function monthPeriodBounds(periodRaw = new Date()) {
  const parsed = periodRaw instanceof Date ? new Date(periodRaw) : new Date(`${String(periodRaw).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error('Período inválido');
    error.status = 400;
    throw error;
  }
  const start = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1));
  const end = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 1));
  return {
    period: start.toISOString().slice(0, 10),
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function padbolCourtProgramMonth(fechaInicio, periodRaw = new Date()) {
  const startRaw = String(fechaInicio || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) return null;
  const start = new Date(`${startRaw}T12:00:00Z`);
  const period = periodRaw instanceof Date
    ? new Date(periodRaw)
    : new Date(`${String(periodRaw || '').slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(period.getTime())) return null;
  const month = (
    (period.getUTCFullYear() - start.getUTCFullYear()) * 12
    + period.getUTCMonth()
    - start.getUTCMonth()
    + 1
  );
  return month > 0 ? month : 0;
}

export function buildPadbolCourtCommercialStatus({
  fechaInicio,
  period = new Date(),
  evaluation = null,
} = {}) {
  const policy = PADBOL_COURT_PRO_POLICY;
  const programMonth = padbolCourtProgramMonth(fechaInicio, period);
  const configurationComplete = evaluation?.configuracion_completa === true;
  const objectivesMet = evaluation?.cumplido === true;
  let phase = 'start_pending';
  let projectedMonthlyUsd = null;
  let referenceMonthlyUsd = null;
  let potentialMonthlyUsd = null;

  if (programMonth === 0) {
    phase = 'not_started';
  } else if (programMonth != null && programMonth <= policy.includedMonths) {
    phase = 'included';
    projectedMonthlyUsd = 0;
    referenceMonthlyUsd = 0;
    potentialMonthlyUsd = 0;
  } else if (programMonth != null) {
    referenceMonthlyUsd = policy.padbolCourtMonthlyUsd;
    potentialMonthlyUsd = policy.objectivesMonthlyUsd;
    if (!configurationComplete) {
      phase = 'objectives_configuration_pending';
    } else if (objectivesMet) {
      phase = 'objectives_met_projected';
      projectedMonthlyUsd = policy.objectivesMonthlyUsd;
    } else {
      phase = 'objectives_in_progress';
    }
  }

  return {
    currency: policy.currency,
    program_month: programMonth,
    phase,
    base_monthly_usd: policy.baseMonthlyUsd,
    included_months: policy.includedMonths,
    padbol_court_monthly_usd: policy.padbolCourtMonthlyUsd,
    objectives_monthly_usd: policy.objectivesMonthlyUsd,
    projected_monthly_usd: projectedMonthlyUsd,
    reference_monthly_usd: referenceMonthlyUsd,
    potential_monthly_usd: potentialMonthlyUsd,
    objectives_configured: configurationComplete,
    objectives_met: evaluation?.cumplido ?? null,
    billing_enabled: policy.billingEnabled,
  };
}

export function addUtcMonthsDate(dateRaw, months) {
  const source = String(dateRaw || '').slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(source) ? new Date(`${source}T12:00:00Z`) : new Date();
  date.setUTCMonth(date.getUTCMonth() + Math.max(0, Number(months) || 0));
  return date.toISOString().slice(0, 10);
}

export function buildPadbolCourtProgramDraft({ sedeId, start, rules: rulesRaw, now = new Date() } = {}) {
  const normalizedSedeId = Number(sedeId);
  const startDate = String(start || now.toISOString().slice(0, 10)).slice(0, 10);
  const rules = normalizeIncentiveRules(rulesRaw);
  const configurationComplete = Object.keys(rules).length === Object.keys(RULE_METRICS).length;
  return {
    sede_id: normalizedSedeId,
    codigo: PADBOL_COURT_PRO_POLICY.code,
    estado: 'borrador',
    meses_base: PADBOL_COURT_PRO_POLICY.includedMonths,
    fecha_inicio: startDate,
    // La fecha exacta de corte/prorrateo todavía no fue decidida. No fabricar
    // un vencimiento contractual a partir de una suma de días o meses.
    fecha_fin_base: null,
    reglas_version: configurationComplete
      ? PADBOL_COURT_PRO_POLICY.version
      : `${PADBOL_COURT_PRO_POLICY.version}-pending-objectives`,
    configuracion: rules,
    updated_at: now.toISOString(),
  };
}

async function fetchAllMetricRows(buildQuery, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function metricsForProgram(supabase, program, bounds) {
  const sedeId = Number(program.sede_id);
  const [tournaments, reservations, activePlayers, padcoinMovements] = await Promise.all([
    fetchAllMetricRows(() => supabase.from('torneos').select('id').eq('sede_id', sedeId).eq('estado', 'finalizado').gte('fecha_fin', bounds.startDate).lt('fecha_fin', bounds.endDate)),
    fetchAllMetricRows(() => supabase.from('reservas').select('id, estado, user_id').eq('sede_id', sedeId).gte('created_at', bounds.startIso).lt('created_at', bounds.endIso)),
    fetchAllMetricRows(() => supabase.from('sede_jugadores').select('user_id').eq('sede_id', sedeId).eq('estado', 'activo')),
    fetchAllMetricRows(() => supabase.from('padcoins_movimientos').select('id, user_id').eq('sede_id', sedeId).gte('created_at', bounds.startIso).lt('created_at', bounds.endIso)),
  ]);
  const tournamentIds = tournaments.map((row) => row.id);
  let scoreboardMatchesCount = 0;
  const registeredByTournament = new Map();
  const scoreboardByTournament = new Map();
  if (tournamentIds.length) {
    const [teams, scoreboardMatches] = await Promise.all([
      fetchAllMetricRows(() => supabase.from('equipos').select('torneo_id, jugadores, inscripcion_estado').in('torneo_id', tournamentIds)),
      fetchAllMetricRows(() => supabase.from('scoreboard_partidos').select('torneo_id, estado').in('torneo_id', tournamentIds).in('estado', ['finalizado', 'terminado'])),
    ]);
    for (const team of teams) {
      if (String(team.inscripcion_estado || '').toLowerCase() !== 'confirmado') continue;
      if (!registeredByTournament.has(team.torneo_id)) registeredByTournament.set(team.torneo_id, new Set());
      for (const player of Array.isArray(team.jugadores) ? team.jugadores : []) {
        const userId = String(typeof player === 'string' ? player : player?.user_id || '').trim().toLowerCase();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
          registeredByTournament.get(team.torneo_id).add(userId);
        }
      }
    }
    for (const match of scoreboardMatches) {
      scoreboardByTournament.set(match.torneo_id, (scoreboardByTournament.get(match.torneo_id) || 0) + 1);
    }
    scoreboardMatchesCount = [...scoreboardByTournament.values()].reduce((sum, count) => sum + count, 0);
  }
  const uuid = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized) ? normalized : '';
  };
  const validReservations = reservations.filter((row) => (
    !['cancelada', 'cancelado'].includes(String(row.estado || '').toLowerCase()) && uuid(row.user_id)
  ));
  const linkedPlayerIds = new Set(activePlayers.map((row) => uuid(row.user_id)).filter(Boolean));
  const reservationPlayerIds = new Set(validReservations.map((row) => uuid(row.user_id)).filter(Boolean));
  const padcoinPlayerIds = new Set(padcoinMovements.map((row) => uuid(row.user_id)).filter(Boolean));
  const tournamentPlayerIds = new Set([...registeredByTournament.values()].flatMap((ids) => [...ids]));
  const candidateUserIds = [...new Set([...linkedPlayerIds, ...reservationPlayerIds, ...padcoinPlayerIds, ...tournamentPlayerIds])];
  const verifiedUserIds = new Set();
  for (let index = 0; index < candidateUserIds.length; index += 100) {
    const profileResult = await supabase
      .from('jugadores_perfil')
      .select('user_id')
      .in('user_id', candidateUserIds.slice(index, index + 100));
    if (profileResult.error) throw profileResult.error;
    for (const profile of profileResult.data || []) {
      const userId = uuid(profile.user_id);
      if (userId) verifiedUserIds.add(userId);
    }
  }
  const monthlyActiveIds = new Set([...reservationPlayerIds, ...padcoinPlayerIds, ...tournamentPlayerIds]);
  return {
    torneos_finalizados: tournamentIds.length,
    jugadores_registrados_torneos: [...tournamentPlayerIds]
      .filter((userId) => verifiedUserIds.has(userId)).length,
    partidos_marcador_finalizados: scoreboardMatchesCount,
    reservas_validas: validReservations.filter((row) => verifiedUserIds.has(uuid(row.user_id))).length,
    jugadores_activos: [...linkedPlayerIds].filter((userId) => verifiedUserIds.has(userId) && monthlyActiveIds.has(userId)).length,
    movimientos_padcoins: padcoinMovements.length,
  };
}

function configuredRulesForProgram(program) {
  const version = String(program?.reglas_version || '').trim();
  if (!version.startsWith(PADBOL_COURT_PRO_POLICY.version)) return {};
  return normalizeIncentiveRules(program?.configuracion || {});
}

export async function evaluateSedeIncentive(supabase, program, period) {
  const bounds = monthPeriodBounds(period);
  const metrics = await metricsForProgram(supabase, program, bounds);
  const evaluation = evaluateIncentiveMetrics(metrics, configuredRulesForProgram(program));
  return {
    period: bounds.period,
    metrics,
    evaluation,
    commercial_status: buildPadbolCourtCommercialStatus({
      fechaInicio: program?.fecha_inicio,
      period: bounds.period,
      evaluation,
    }),
    preview: true,
    persisted: false,
    credito_otorgado: false,
    reason_code: 'pricing_v2_billing_closed',
  };
}

export async function previewSedeIncentive(supabase, program, period = new Date()) {
  return evaluateSedeIncentive(supabase, program, period);
}

export function registerSedeIncentiveRoutes(app, deps) {
  const { supabase, adminListScopeFromRequest, assertUsuarioPuedeAdministrarSede, assertSuperAdminReq } = deps;

  app.get('/api/admin/incentivos', async (req, res) => {
    try {
      const scope = await adminListScopeFromRequest(req);
      if (!scope) return res.status(401).json({ error: 'No autorizado' });
      const requested = Number(req.query?.sede_id);
      let sedeIds = [];
      if (Number.isFinite(requested)) {
        await assertUsuarioPuedeAdministrarSede(req, requested);
        sedeIds = [requested];
      } else if (scope.superA) {
        const { data, error } = await supabase.from('sedes').select('id');
        if (error) throw error;
        sedeIds = (data || []).map((row) => Number(row.id)).filter(Number.isFinite);
      } else {
        return res.status(400).json({ error: 'Selecciona una sede' });
      }
      if (!sedeIds.length) return res.json({ policy: PADBOL_COURT_PRO_POLICY, programs: [] });
      const { data: programs, error } = await supabase.from('sede_programas_beneficios').select('*').in('sede_id', sedeIds).eq('codigo', 'padbol_pro_renovable');
      if (error) throw error;
      const ids = (programs || []).map((row) => row.id);
      let progress = [];
      if (ids.length) {
        const progressResult = await supabase.from('sede_beneficio_progreso').select('*').in('programa_id', ids).order('periodo', { ascending: false }).limit(120);
        if (progressResult.error) throw progressResult.error;
        progress = progressResult.data || [];
      }
      const decorated = await Promise.all((programs || []).map(async (program) => {
        let currentProgress = null;
        let progressReasonCode = null;
        try {
          currentProgress = await previewSedeIncentive(supabase, program, new Date());
        } catch (previewError) {
          progressReasonCode = 'metrics_unavailable';
          console.warn(`⚠️ Incentivos sede ${program.sede_id}: métricas no disponibles`, previewError?.message || previewError);
        }
        return {
          ...program,
          progreso: progress.filter((row) => row.programa_id === program.id),
          current_progress: currentProgress,
          progress_reason_code: progressReasonCode,
          legacy_configuration: !String(program.reglas_version || '').startsWith(PADBOL_COURT_PRO_POLICY.version),
        };
      }));
      return res.json({ policy: PADBOL_COURT_PRO_POLICY, programs: decorated });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/admin/incentivos/:sedeId/activar', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const sedeId = Number(req.params.sedeId);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'Sede inválida' });
      const { data: sede, error: sedeError } = await supabase
        .from('sedes')
        .select('id, stripe_subscription_id')
        .eq('id', sedeId)
        .maybeSingle();
      if (sedeError) throw sedeError;
      if (!sede) return res.status(404).json({ error: 'Sede no encontrada' });
      if (String(sede.stripe_subscription_id || '').trim()) {
        return res.status(409).json({
          error: 'La sede tiene una suscripción automática activa. Pausá primero la facturación para evitar un cobro durante el beneficio.',
        });
      }
      // Borrador informativo: no dispara el trigger legado que concede Pro ni
      // habilita facturación antes de resolver los pendientes comerciales.
      const payload = buildPadbolCourtProgramDraft({
        sedeId,
        start: req.body?.fecha_inicio,
        rules: req.body?.configuracion,
      });
      const { data, error } = await supabase.from('sede_programas_beneficios').upsert(payload, { onConflict: 'sede_id,codigo' }).select('*').single();
      if (error) throw error;
      return res.status(201).json(data);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.patch('/api/admin/incentivos/:sedeId', async (req, res) => {
    try {
      await assertSuperAdminReq(req);
      const sedeId = Number(req.params.sedeId);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'Sede inválida' });
      const rules = normalizeIncentiveRules(req.body?.configuracion || {});
      const configurationComplete = Object.keys(rules).length === Object.keys(RULE_METRICS).length;
      const patch = {
        configuracion: rules,
        reglas_version: configurationComplete ? PADBOL_COURT_PRO_POLICY.version : `${PADBOL_COURT_PRO_POLICY.version}-pending-objectives`,
        updated_at: new Date().toISOString(),
      };
      if (req.body?.estado === 'activo') {
        return res.status(409).json({
          error: 'La activación comercial permanece cerrada hasta definir objetivos y facturación.',
          code: 'COMMERCIAL_ACTIVATION_CLOSED',
        });
      }
      if (req.body?.estado && ['borrador', 'pausado', 'finalizado'].includes(req.body.estado)) patch.estado = req.body.estado;
      const { data, error } = await supabase.from('sede_programas_beneficios').update(patch).eq('sede_id', sedeId).eq('codigo', 'padbol_pro_renovable').select('*').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Programa no encontrado' });
      return res.json(data);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });

  app.post('/api/admin/incentivos/:sedeId/evaluar', async (req, res) => {
    try {
      const sedeId = Number(req.params.sedeId);
      if (!Number.isFinite(sedeId)) return res.status(400).json({ error: 'Sede inválida' });
      const scope = await assertUsuarioPuedeAdministrarSede(req, sedeId);
      const { data: program, error } = await supabase.from('sede_programas_beneficios').select('*').eq('sede_id', sedeId).eq('codigo', 'padbol_pro_renovable').maybeSingle();
      if (error) throw error;
      if (!program) return res.status(404).json({ error: 'La sede no tiene un programa activo' });
      const requestedPeriod = req.body?.periodo || new Date();
      return res.json(await evaluateSedeIncentive(supabase, program, requestedPeriod, scope.email || 'sistema'));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message });
    }
  });
}

export async function evaluateAllActiveSedeIncentives(supabase, period = new Date()) {
  const { data, error } = await supabase.from('sede_programas_beneficios').select('*').eq('codigo', 'padbol_pro_renovable').eq('estado', 'activo');
  if (error) throw error;
  const results = [];
  for (const program of data || []) {
    try {
      results.push({ programa_id: program.id, ok: true, ...(await evaluateSedeIncentive(supabase, program, period, 'cron')) });
    } catch (evaluationError) {
      results.push({ programa_id: program.id, ok: false, error: evaluationError.message });
    }
  }
  return results;
}

export async function reconcileExpiredSedeIncentives() {
  const error = new Error(
    'La reconciliación anterior otorgaba meses gratis y no corresponde al esquema comercial vigente.',
  );
  error.status = 409;
  error.code = 'LEGACY_INCENTIVE_RECONCILIATION_DISABLED';
  throw error;
}

export { DEFAULT_RULES };
