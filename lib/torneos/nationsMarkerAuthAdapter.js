const fail = (code, status = 403) => { throw Object.assign(new Error(code), { code, status }); };
const ALLOWED = new Set(['super_admin', 'admin_club', 'admin_sede']);
/** Auth adapter: identidad SOLO por getAuthenticatedUser(req) inyectado; rol persistido real. */
export function createNationsMarkerAuthAdapter({ getAuthenticatedUser, fetchUserRoleRowForAuthUser, loadContext, controlTokenMode = 'unsupported' }) {
  if (typeof getAuthenticatedUser !== 'function' || typeof fetchUserRoleRowForAuthUser !== 'function' || typeof loadContext !== 'function') throw new Error('AUTH_PORTS_REQUIRED');
  return async function authorize(req, ctx = {}) {
    if (controlTokenMode !== 'unsupported') fail('CONTROL_TOKEN_NOT_IMPLEMENTED', 409);
    const matchId = String(ctx.matchId ?? ctx.partidoId ?? '');
    if (!matchId) fail('MATCH_ID_REQUIRED', 400);
    let result;
    try { result = await getAuthenticatedUser(req); }
    catch (e) { fail(e?.status === 401 ? 'AUTH_REQUIRED' : 'AUTH_UNAVAILABLE', e?.status === 401 ? 401 : 503); }
    if (!result || typeof result !== 'object') fail('AUTH_UNAVAILABLE', 503);
    if (result.status === 401 || result.error === 'missing' || result.error === 'expired') fail('AUTH_REQUIRED', 401);
    if (result.error || result.status >= 400) fail('AUTH_UNAVAILABLE', 503);
    const user = result.user;
    if (!user?.id) fail('AUTH_REQUIRED', 401);
    let row;
    try { row = await fetchUserRoleRowForAuthUser(user); }
    catch { fail('ROLE_LOOKUP_FAILED', 503); }
    const role = String(row?.role || '').trim().toLowerCase();
    if (!ALLOWED.has(role)) fail('FORBIDDEN', 403);
    let context;
    try { context = await loadContext(matchId); }
    catch { fail('CONTEXT_UNAVAILABLE', 503); }
    if (context?.notNations) {
      if (role !== 'super_admin' && (row?.sede_id == null || Number(row.sede_id) !== Number(context.sedeId))) fail('FORBIDDEN_SEDE', 403);
      fail('NOT_NATIONS_TOURNAMENT', 403);
    }
    if (!context?.membership?.A || !context?.membership?.B) fail('MATCH_CONTEXT_INVALID', 500);
    if (role !== 'super_admin' && (row?.sede_id == null || Number(row.sede_id) !== Number(context.sedeId))) fail('FORBIDDEN_SEDE', 403);
    const teamId = ctx.teamId != null ? String(ctx.teamId) : null;
    if (teamId && ![String(context.membership.A), String(context.membership.B)].includes(teamId)) fail('TEAM_NOT_IN_MATCH', 403);
    return { actorId: String(user.id), role, sedeId: context.sedeId, teamId, canControlMatch: true };
  };
}
