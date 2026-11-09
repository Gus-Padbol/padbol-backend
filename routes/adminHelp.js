import { ADMIN_HELP_ARTICLES } from '../lib/adminHelpArticles.js';

const ADMIN_ROLES = new Set(['super_admin', 'admin_club', 'admin_nacional', 'admin_cadena']);
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const fail = (res, status, code) => res.status(status).json({ error: code, code });

// No tenant data is returned. Re-read the existing persisted assignment on each
// request and immediately before delivery, rather than trusting JWT role claims.
export async function readAdminHelpRole(supabaseAdmin, user) {
  if (!user?.id) return null;
  const { data, error } = await supabaseAdmin.from('user_roles')
    .select('user_id,role,alcance,sede_id,organizacion_id,pais,provincia,ciudad')
    .eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data;
}

export function mountAdminHelpRoutes(app, { getAuthenticatedUser, fetchUserRoleRowForAuthUser, articles = ADMIN_HELP_ARTICLES }) {
  async function context(req) {
    const auth = await getAuthenticatedUser(req);
    if (!auth?.user?.id) return { status: 401, code: 'HELP_UNAUTHENTICATED' };
    const row = await fetchUserRoleRowForAuthUser(auth.user);
    const role = String(row?.role || row?.rol || '').trim().toLowerCase();
    if (!ADMIN_ROLES.has(role) || (role === 'admin_club' && (!Number.isInteger(Number(row?.sede_id)) || Number(row?.sede_id) <= 0))) return { status: 403, code: 'HELP_FORBIDDEN' };
    // Include the full persisted assignment to detect scope/version changes too.
    return { role, fingerprint: JSON.stringify([auth.user.id, Object.entries(row).sort(([a], [b]) => a.localeCompare(b))]) };
  }
  const handler = detail => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Authorization');
    try {
      const initial = await context(req);
      if (initial.status) return fail(res, initial.status, initial.code);
      // Filter BEFORE inspecting titles, translations, text or counts.
      const allowed = articles.filter(a => a.status === 'reviewed' && a.allowedRoles.includes(initial.role));
      const lang = req.query.lang === undefined ? 'es' : req.query.lang;
      if (typeof lang !== 'string' || !['es', 'en', 'pt'].includes(lang)) return fail(res, 400, 'HELP_INVALID_LANGUAGE');
      let selected;
      if (detail) {
        // Unknown modules and denied modules have the same response.
        if (!allowed.some(a => a.module === req.params.module)) return fail(res, 403, 'HELP_FORBIDDEN');
        selected = allowed.filter(a => a.module === req.params.module && a.slug === req.params.slug);
        if (!selected.length) return fail(res, 403, 'HELP_FORBIDDEN');
      } else {
        const q = req.query.q === undefined ? '' : req.query.q;
        if (typeof q !== 'string' || q.length > 120) return fail(res, 400, 'HELP_INVALID_QUERY');
        selected = allowed;
      }
      if (selected.some(a => !a.translations[lang])) return fail(res, 409, 'HELP_LOCALIZATION_UNAVAILABLE');
      let projected = selected.map(a => ({
        id: a.id, module: a.module, slug: a.slug, lang,
        url: `/ayuda/administracion/${a.module}/${a.slug}`, status: a.status,
        verification: a.verification, sourceVersion: a.sourceVersion,
        ...a.translations[lang],
      }));
      if (!detail) {
        const terms = normalize((req.query.q || '').trim()).split(/\s+/).filter(Boolean);
        projected = projected.filter(a => {
          const text = normalize([a.title, ...a.requirements, ...a.steps].join(' '));
          return terms.every(term => text.includes(term));
        }).map(({ requirements, steps, limit, ...summary }) => ({ ...summary, snippet: (steps[0] || requirements[0] || '').slice(0, 240) }));
      }
      const final = await context(req);
      if (final.status) return fail(res, final.status, final.code);
      if (initial.fingerprint !== final.fingerprint) return fail(res, 403, 'HELP_CONTEXT_CHANGED');
      return res.json(detail ? { article: projected[0] } : { results: projected, total: projected.length, lang });
    } catch {
      return fail(res, 503, 'HELP_UNAVAILABLE');
    }
  };
  app.get('/api/admin/help/search', handler(false));
  app.get('/api/admin/help/articles/:module/:slug', handler(true));
}
