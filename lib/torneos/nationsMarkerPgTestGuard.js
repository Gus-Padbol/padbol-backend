import pg from 'pg';

/** No connection is opened. Validate the effective configuration used by pg,
 * including its query overrides, without trusting a superficial URL host. */
export function assertSafeMarkerPgUrl(url) {
  const refuse = () => { throw new Error('REFUSE_DESTRUCTIVE_PG_TARGET'); };
  const raw = String(url || '');
  if (!/^postgres(?:ql)?:\/\//.test(raw) || raw.includes('#') || raw.split('?').length > 2) refuse();
  const [head, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  if ([...params.keys()].some(key => !['host', 'port'].includes(key)) ||
      [...params.keys()].some(key => params.getAll(key).length !== 1)) refuse();
  const socket = /^postgres(?:ql)?:\/\/[^/@]*@\/marker_test$/.test(head);
  const tcp = /^postgres(?:ql)?:\/\/[^/@]+@(127\.0\.0\.1|localhost):55439\/marker_test$/.test(head);
  if ((!socket && !tcp) || (tcp && query) ||
      (socket && (params.get('host') !== '/tmp/nations-marker-pg-sock' || params.get('port') !== '55439'))) refuse();
  let effective;
  try { effective = new pg.Client({ connectionString: raw }).connectionParameters; } catch { refuse(); }
  if (!['127.0.0.1', 'localhost', '/tmp/nations-marker-pg-sock'].includes(effective.host) ||
      Number(effective.port) !== 55439 || effective.database !== 'marker_test') refuse();
  return true;
}
