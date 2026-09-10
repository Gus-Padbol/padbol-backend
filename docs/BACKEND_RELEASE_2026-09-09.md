# Backend QA release — 2026-09-09

This release extends the existing `server.js` from main `5d6411ef8bf610cbe5a4db645560e152bd664411`. It preserves the existing Express/Socket.IO runtime, support tickets, identity/history, sporting features, payment entrypoints, and the existing public DTOs. It does not replace the server with the separate local monolith.

## Included

- Private FIPA document library, authorization requests/grants, and audited short-lived download links. Documents remain drafts until an authorized publication workflow is completed.
- WhatsApp Cloud webhook verification, signature validation over the raw request, and persisted outbox. Delivery requires explicit activation and provider configuration.
- Private push installation registry, per-installation language, opt-out/revocation, safe destinations, delivery audit, receipts and territorial administration. Existing push producers use this registry; old profile token columns are no longer a delivery fallback. The old token URL now requires platform and deviceId too.
- Composed country/province/city authorization. Inactive organizations have no venue access. Revoked roles cannot regain superadmin from an email allowlist. Pending email assignments are linked only to the confirmed authenticated owner using a conditional update; no bulk backfill runs.
- Legal eligibility and canonical account-deletion requests, preserving the old deletion URL as an adapter. This registers a request; it does not claim that complete deletion has occurred.
- Role assignments, invitations, venue onboarding, organization and incentive APIs from the validated local work. Venue inserts must contain real price, court count, contact and opening hours required by the deployed schema. Incentive drafts do not activate billing.
- Alias availability returning only `{ available }`; direct anonymous profile access is closed by addendum 11. Public profiles remain behind the existing explicit backend DTO.

## Schema and deployment order

Use the reviewed ten-migration bundle separately; do not run all historical SQL files in this repository. Add `sql/20260909233000_player_profile_privacy.sql` as migration 11 after that bundle. It changes permissions/policies only, not user rows. It removes anonymous table/column privileges and email-based ownership policies; authenticated clients can select/insert/update only their own UUID profile. Service access remains available to the backend.

Deploy the frontend changes that replace public profile-table queries with the backend DTO and the alias availability endpoint. Anonymous people search requires sign-in. Preserve own-profile registration/update. Public legal URLs and the candidate legal version must be reviewed before any release to real users.

## Runtime configuration

Use Node 22 and repository-root `npm ci`, then `npm start`. Render health check: `/health`. `PORT`, `CORS_ORIGINS` (comma separated) and `CORS_ORIGIN` are supported; Socket.IO uses the configured origins too.

Start from `.env.staging.example`. Set the distinct staging and production Supabase project references, the exact staging HTTPS URL, and its own server credentials. Never copy production credentials. SQL-dependent legacy APIs need `DATABASE_URL`: the staging guard accepts only that exact project's direct host or a Supabase pooler with username `postgres.<staging-reference>`, database `postgres`, and explicit TLS. No URL query overrides are accepted.

Keep `BACKGROUND_JOBS_ENABLED=false`, `OUTBOUND_DELIVERY_ENABLED=false`, `PUSH_SEND_ENABLED=false`, and `WHATSAPP_CLOUD_SEND_ENABLED=false` for initial QA. Payment routes are blocked before their handlers when external operations are disabled, including SDKs with independent HTTP transports. A separate guard covers fetch-based transports.

`/ready` verifies the release schema and SQL connectivity. It returns 503 when SQL is unavailable, even if REST is healthy. Readiness is not proof of real delivery, published PDFs, legal approval, store declarations, or end-to-end browser operation. Check migration 11 permissions separately using the reviewed role fixtures.

WhatsApp callback: `GET`/`POST /api/webhooks/whatsapp-cloud`. Set the verify token and app secret only through service configuration. A verified local challenge does not establish a public callback.

## Verification

- Clean dependencies and 1,538 backend tests passed on Node 22, including the retained baseline suite, geographic homonyms/missing parents, revocation, installation targeting, disabled delivery and integration contracts.
- Nine loopback HTTP checks passed against the actual server entrypoint: health, CORS, raw WhatsApp signature rejection/challenge, FIPA and push authentication, payment guard, deletion and alias route. Supabase was stubbed; no providers were contacted.
- Addendum 11 passed 16 real PostgreSQL 17 RLS/privilege checks; the original 153-case QA SQL fixture also passed after it. Synthetic data was rolled back.
- The route inventory preserves every baseline method/URL. Public profile DTO tests from the existing suite are retained.

## Explicit remaining work

This is the deployable QA core, not a declaration that every frontend promise is fulfilled. Stripe PaymentIntent used by the current booking UI is absent from main; the local handler trusts the client amount and must be adapted to current server-side pricing before reuse. Plan commissions still need integration with the active payment flow. Additional frontend/API gaps have a separate inventory (booking availability/holds, check-in, requests to join matches and Chivi among them). National/chain venue selection is restricted correctly, while several older admin tools still reject those roles and need deliberate scoped integration.

Direct modification of authoritative fields within one's profile (for example federation/XP) is a separate authorization issue; closing anonymous disclosure does not claim to solve it. Real push delivery, public WhatsApp verification, PDF publication/downloads and user-facing flows require coordinated QA before production.

Rollback application code to the prior release if needed, preserving reviewed SQL and privacy restrictions. Do not restore anonymous profile access as an automatic rollback. Production `main`, provider settings and real messages are outside this QA branch deployment step.
