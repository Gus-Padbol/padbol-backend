import {createPrivateKey, createSign} from 'node:crypto';

export const GA4_PROPERTY_ID = '435359413';
export const GA4_MEASUREMENT_ID = 'G-YSJQXF18JV';
export const GA4_STREAM_ID = '7814357529';
const scope = 'https://www.googleapis.com/auth/analytics.readonly';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const reportUrl = `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:batchRunReports`;
const fail = (code, status = 503) => Object.assign(Error(code), {code, status});
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const shift = (value, n) => new Date(Date.parse(value + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function localDay(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(value);
}
function credentials(env) {
  const email = String(env.GA4_READ_SERVICE_ACCOUNT_EMAIL || '').trim();
  if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/.test(email)) return null;
  try {
    const key = createPrivateKey(String(env.GA4_READ_SERVICE_ACCOUNT_PRIVATE_KEY || '').replaceAll('\\n', '\n'));
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) return null;
    return {email, key};
  } catch { return null; }
}
function number(value) {
  if (value == null || value === '') return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw fail('GA4_INVALID_RESPONSE');
  return Number(value);
}
function rows(report, metricNames, dimensions) {
  if (!report || JSON.stringify((report.metricHeaders || []).map(h => h.name)) !== JSON.stringify(metricNames)
      || JSON.stringify((report.dimensionHeaders || []).map(h => h.name)) !== JSON.stringify(dimensions)) throw fail('GA4_INVALID_RESPONSE');
  const data = report.rows || [];
  const count = report.rowCount ?? 0;
  if (!Array.isArray(data) || data.length > 92 || !Number.isSafeInteger(count) || count < 0 || count !== data.length) throw fail('GA4_INVALID_RESPONSE');
  return data.map(row => {
    if (row.metricValues?.length !== metricNames.length || (row.dimensionValues || []).length !== dimensions.length) throw fail('GA4_INVALID_RESPONSE');
    return {values: row.metricValues.map(v => number(v.value)), dimensions: (row.dimensionValues || []).map(v => v.value)};
  });
}

/** Private, aggregate-only reader. It never receives a property, credential or actor from report parameters. */
export function createContentAnalytics({pool, env = process.env, fetchImpl = globalThis.fetch, now = () => new Date()} = {}) {
  if (!pool?.connect) throw fail('GA4_DATABASE_UNAVAILABLE');
  const account = credentials(env);
  let accessToken = null, expiresAt = 0;
  let defaultTimezone = String(env.GA4_READ_TIMEZONE || 'America/Argentina/Buenos_Aires');
  try { localDay(now(), defaultTimezone); } catch { defaultTimezone = 'America/Argentina/Buenos_Aires'; }
  async function authorize(actor) {
    if (!uuid(actor)) throw fail('FORBIDDEN', 403);
    const client = await pool.connect();
    try {
      const result = await client.query('select public.content_meta_access($1) allowed', [actor]);
      if (result.rows[0]?.allowed !== true) throw fail('FORBIDDEN', 403);
    } finally { client.release(); }
  }
  async function post(url, body, headers) {
    let response, data;
    try {
      response = await fetchImpl(url, {method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(15000)});
      // API replies are aggregate reports only; bound the response before parsing.
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw Error('response too large');
      data = JSON.parse(raw);
    } catch { throw fail('GA4_READ_UNAVAILABLE'); }
    if (!response.ok) throw fail(response.status === 401 || response.status === 403 ? 'GA4_READ_AUTHORIZATION_FAILED' : 'GA4_READ_UNAVAILABLE');
    return data;
  }
  async function token() {
    if (accessToken && expiresAt > now().getTime() + 60000) return accessToken;
    const iat = Math.floor(now().getTime() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({alg: 'RS256', typ: 'JWT'}) + '.' + encode({iss: account.email, scope, aud: tokenUrl, iat, exp: iat + 3600});
    let assertion;
    try { assertion = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).end().sign(account.key, 'base64url'); }
    catch { throw fail('GA4_READ_CONNECTION_NOT_CONFIGURED', 409); }
    const data = await post(tokenUrl, new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}).toString(), {'Content-Type': 'application/x-www-form-urlencoded'});
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192
      || data.token_type !== 'Bearer' || !Number.isFinite(data.expires_in) || data.expires_in < 120 || data.expires_in > 7200) throw fail('GA4_INVALID_RESPONSE');
    accessToken = data.access_token; expiresAt = now().getTime() + data.expires_in * 1000;
    return accessToken;
  }
  return {
    async status(actor) {
      await authorize(actor);
      return {canRead: true, propertyId: GA4_PROPERTY_ID, measurementId: GA4_MEASUREMENT_ID, streamId: GA4_STREAM_ID,
        connection: {status: account ? 'configured' : 'not_configured',
          message: account ? 'Credencial de lectura configurada. Consulta un período para verificar el acceso a los informes.' : 'Falta autorizar la lectura de Google Analytics para mostrar sus informes.'}};
    },
    async summary(actor, query = {}) {
      await authorize(actor);
      if (!account) throw fail('GA4_READ_CONNECTION_NOT_CONFIGURED', 409);
      if (Object.keys(query).some(key => !['since', 'until'].includes(key))) throw fail('GA4_INVALID_DATE', 400);
      const today = localDay(now(), defaultTimezone), since = query.since ?? shift(today, -28), until = query.until ?? shift(today, -1);
      if (!day(since) || !day(until) || since > until || until >= today || (Date.parse(until) - Date.parse(since)) / 86400000 > 91) throw fail('GA4_INVALID_DATE', 400);
      const metrics = ['activeUsers', 'sessions', 'screenPageViews'];
      const base = {dateRanges: [{startDate: since, endDate: until}], keepEmptyRows: false, limit: '100'};
      const leadFilter = {filter: {fieldName: 'eventName', stringFilter: {matchType: 'EXACT', value: 'lead_success', caseSensitive: true}}};
      const streamFilter = {filter: {fieldName: 'streamId', stringFilter: {matchType: 'EXACT', value: GA4_STREAM_ID, caseSensitive: true}}};
      const request = (daily, leads) => ({...base, dimensions: daily ? [{name: 'date'}] : [], metrics: (leads ? ['eventCount'] : metrics).map(name => ({name})), dimensionFilter: leads ? {andGroup: {expressions: [streamFilter, leadFilter]}} : streamFilter});
      const result = await post(reportUrl, JSON.stringify({requests: [request(false, false), request(true, false), request(false, true), request(true, true)]}), {'Content-Type': 'application/json', Authorization: 'Bearer ' + await token()});
      if (!Array.isArray(result.reports) || result.reports.length !== 4) throw fail('GA4_INVALID_RESPONSE');
      const [totalReport, dailyReport, leadReport, leadDailyReport] = result.reports;
      const timezones = new Set(result.reports.map(r => r.metadata?.timeZone).filter(Boolean));
      if (timezones.size !== 1) throw fail('GA4_INVALID_RESPONSE');
      const timezone = [...timezones][0];
      let propertyToday;
      try { propertyToday = localDay(now(), timezone); } catch { throw fail('GA4_INVALID_RESPONSE'); }
      if (until >= propertyToday) throw fail('GA4_PARTIAL_DAY_NOT_ALLOWED', 400);
      const totals = rows(totalReport, metrics, []), days = rows(dailyReport, metrics, ['date']), leads = rows(leadReport, ['eventCount'], []), leadDays = rows(leadDailyReport, ['eventCount'], ['date']);
      if (totals.length > 1 || leads.length > 1) throw fail('GA4_INVALID_RESPONSE');
      const daily = new Map();
      function add(row, isLead) {
        const raw = row.dimensions[0];
        if (typeof raw !== 'string' || !/^\d{8}$/.test(raw)) throw fail('GA4_INVALID_RESPONSE');
        const date = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
        if (!day(date) || date < since || date > until) throw fail('GA4_INVALID_RESPONSE');
        const existing = daily.get(date) || {date, activeUsers: null, sessions: null, pageViews: null, leads: null};
        if (isLead) existing.leads = row.values[0];
        else [existing.activeUsers, existing.sessions, existing.pageViews] = row.values;
        daily.set(date, existing);
      }
      const unique = (items, isLead) => {const seen = new Set(); for (const row of items) {if (seen.has(row.dimensions[0])) throw fail('GA4_INVALID_RESPONSE'); seen.add(row.dimensions[0]); add(row, isLead);}};
      unique(days, false); unique(leadDays, true);
      const warnings = ['Las consultas medidas por Analytics no equivalen a ventas ni sustituyen los registros del CRM.', 'Los usuarios del período se consultan directamente; no se suman los usuarios diarios.'];
      if (!totals.length || !leads.length) warnings.push('GA4 no devolvió algunas métricas para este período. Se muestran sin dato, no como cero.');
      if (result.reports.some(r => r.metadata?.subjectToThresholding || r.metadata?.dataLossFromOtherRow || r.metadata?.dataTruncationReasons?.length)) warnings.push('Google informa límites de privacidad o agregación que pueden reducir los datos disponibles.');
      if (result.reports.some(r => r.metadata?.samplingMetadatas?.length)) warnings.push('Google informa que este período contiene datos muestreados.');
      const [activeUsers = null, sessions = null, pageViews = null] = totals[0]?.values || [];
      return {range: {since, until, timezone}, totals: {activeUsers, sessions, pageViews, leads: leads[0]?.values[0] ?? null}, daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
        meta: {source: 'ga4_data_api', propertyId: GA4_PROPERTY_ID, measurementId: GA4_MEASUREMENT_ID, streamId: GA4_STREAM_ID, queriedAt: now().toISOString(), warnings}};
    },
  };
}
