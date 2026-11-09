# Administrative help role review

Reviewed against backend base `42f4a8046911db1e0d8fe0314176b4a5e2f118cf`. References below refer to that base (server line numbers in the candidate shift by three after help mounting). This is source review, not an authenticated production walkthrough. Frontend tab visibility is not authorization.

## Per-module upper bounds for operational guidance

| Module | Roles allowed by the reviewed operation | References at base42 |
| --- | --- | --- |
| administracion | admin_club, admin_cadena, admin_nacional, super_admin; generic orientation only | Existing role model: lib/releaseServices.js:33-51; new guide guard is routes/adminHelp.js in fac21d94, NOT base42 |
| sedes | admin_club, super_admin | routes/sedesProfile.js:273,411; routes/sedesDuraciones.js:80,211,264,334; lib/authAccess.js:211 |
| reservas | admin_club, super_admin | server.js:1557; lib/authAccess.js:122; mutations server.js:1697,1776 |
| validaciones | admin_club, super_admin for list/approve; rejection super_admin only | routes/adminValidationAndChannels.js:51,84,90,109,139 |
| torneos | admin_club, super_admin | server.js:1923,1940,2054; lib/torneos/torneoAdminAccessService.js:31 |
| marcador | admin_club, super_admin for this guide | routes/scoreboard.js:58,562,589; legacy admin_sede also supported by scoreboard but is not an authorized help role |
| jugadores | admin_club, super_admin | routes/adminJugadores.js:41,76; lib/authAccess.js:1,39 |
| membresias | admin_club, super_admin | routes/membresias.js:149-160; service additionally enforces venue scope |
| incentivos | Read/evaluate: administrative venue scope; configure/prepare: super_admin only | lib/sedeIncentivesV4.js:611,619,666,715,749; routes/commercialRelease.js:71; lib/releaseServices.js:33 |
| notificaciones | admin_club, admin_cadena, admin_nacional, super_admin, constrained segments/quotas/scope | lib/adminPushNotifications.js:11,142,245,291,397,534-545; lib/releaseServices.js:33-51 |
| soporte | super_admin | routes/supportTickets.js:77 onward; lib/authAccess.js:60 |
| configuracion | super_admin for points configuration | routes/pointsConfig.js:7; do not infer authorization for every setting from this one gate |

## Required content corrections

- Remove admin_cadena from operational reservas/marcador guidance; remove admin_cadena and admin_nacional from operational torneos/jugadores guidance. Their ability to see a tab does not grant these backend operations.
- Other roles may access their OWN reservations as ordinary users; this does not make them reservation administrators.
- Club procedures must state own assigned venue only. The help API requires a positive persisted sede_id for admin_club. A generic article must never promise arbitrary venue access.
- National/chain push requires valid persisted geographic/organization scope, not a role claim or arbitrary client selection.
- Split validation rejection into a super_admin-only article. Do not include rejection steps in a shared article and rely on frontend hiding.
- Split incentives read/evaluation from super_admin configuration. Activation endpoint currently only prepares a draft; commercial activation, billing and credit granting remain closed. Never describe preview as a granted benefit.
- Support and points configuration stay super_admin-only. No private ticket, person or tenant data belongs in the help corpus.
- Every procedure requires concrete verified UI and backend source references. Do not cite routes/adminHelp.js as existing at base42: it was introduced by fac21d94.

## Automated review

`node scripts/check-admin-help-corpus.mjs /absolute/path/admin-help-articles.json` checks schema, translations, duplicate routes, reviewed status and module role ceilings. It is NOT semantic review or runtime authorization proof. It deliberately rejects runtimeEligible:false wrappers. Incentives and validation mixed-operation articles need human review as described above, regardless of an automated pass. Do not modify a corpus owned by another contributor to silence validation errors.
