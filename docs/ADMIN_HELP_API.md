# Protected administrative help API

Server-only corpus: `lib/adminHelpArticles.js`. Never copy this corpus to frontend/public/PDF output.

- `GET /api/admin/help/search?q=&lang=es` returns `{results,total,lang}`. Empty q lists all authorized articles. q is a string up to 120 characters. Search covers title, requirements and steps, with case/accent folding, basic plural normalization, ES/EN/PT question stopwords and a small explicit action/domain synonym list. All useful query terms are required; a nonempty query containing only stopwords returns no results. No external AI or network search is used.
- Each summary has `id,module,slug,title,snippet,url,lang,status,verification,sourceVersion`.
- `GET /api/admin/help/articles/:module/:slug?lang=es` returns `{article}` with the summary fields except snippet, plus `requirements,steps,limit`.
- `url` is `/ayuda/administracion/:module/:slug`. The center is `/ayuda/administracion`.
- `lang` accepts es/en/pt, defaults to es. Missing translations return 409 without fallback. The reviewed corpus contains twenty articles in ES/EN/PT. Translation availability is still checked per authorized article.
- All responses set `Cache-Control: private, no-store` and `Vary: Authorization`.
- Error body: `{error: CODE, code: CODE}`. 401 HELP_UNAUTHENTICATED; 403 HELP_FORBIDDEN (including every inaccessible or nonexistent detail); 403 HELP_CONTEXT_CHANGED; 400 HELP_INVALID_LANGUAGE/HELP_INVALID_QUERY; 409 HELP_LOCALIZATION_UNAVAILABLE; 503 HELP_UNAVAILABLE.

## Authorization

Existing server token verification is reused. Persisted `user_roles` is read only by verified user_id, with no email fallback or claim/update. Pending unbound assignments deny access until linked by the existing application flow. JWT/user metadata, query parameters and headers never grant roles.

Roles: super_admin, admin_club, admin_nacional and admin_cadena; club additionally requires a positive integral persisted sede_id. Each article has an explicit allowedRoles array. Generic role guidance contains no tenant records. Support guidance is super_admin-only. Filtering precedes title/text/translation/count access. Authentication and the complete selected persisted role/scope assignment are reread before delivery; changes or failures discard the result. This does not introduce a session registry beyond the application's existing auth verifier.

## Corpus schema and review

`{id,module,slug,allowedRoles,status,verification,sourceVersion,translations}`. Only status `reviewed` is eligible. verification must accurately distinguish source-reviewed instructions from runtime-verified procedures. translations contains language objects `{title,requirements:[],steps:[],limit}`. No persons, tenant records, credentials, private ticket text or promised response times. The twenty integrated articles were source-reviewed against frontend 798c844e and backend 42f4a804, with final corrections for validation error handling, role-specific push segments and points copy. This is not an authenticated production walkthrough. Changes to this corpus require another source review.

## Release

No migrations, credentials or permission changes. Deploy code only from a clean canonical registered candidate at an identifiable commit, after the full suite and release preflight under Node >=22.23.4 (22.x). Validate production/QA separately, never infer target from branch. Roll back by restoring the preceding deployed code commit; no data rollback needed. Verify 401/no-store anonymously and authenticated role, localization, denied detail and search cases against the actual target before announcing availability.

## Current production rebase (10 November 2026)

Base backend706f515a, frontend e2a3493. Player guidance remains venue-scoped for club admins; the global roster is super_admin-only. Bulk approval/rejection copy follows frontend553ce658, with sequential requests, explicit confirmation, partial progress and refresh-before-retry. No roles, permission gates, database writes or Nations behavior were changed by this integration. P09 fixture fix is already upstream and was not reapplied.
