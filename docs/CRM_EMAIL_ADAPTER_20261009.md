# CRM outbound email adapter (prepared, not activated)

The previous CRM reply service rejected every non-WhatsApp conversation before looking for an email transport. Changing only environment flags could not restore email replies. This patch injects an explicit sender callback, exposes `emailSendEnabled` in operator permissions and records a reply as pending before provider delivery. Provider acceptance with a message identifier marks it sent; explicit rejection marks it cancelled. Network uncertainty, a provider 5xx or a failed audit update leaves it pending with a warning, rather than claiming that delivery did not happen.

The implemented provider is Resend, already used by the backend for invitations. SMTP is not implemented and therefore is not reported as enabled merely because `SMTP_URL` is present. The adapter has no default sender, recipient, credentials or automated sweep. It uses the conversation's stored contact email and the persisted reply ID as the provider idempotency key.

Required operational configuration: `BACKEND_RUNTIME_MODE=production`, `OUTBOUND_DELIVERY_ENABLED=true`, `CRM_OUTBOUND_EMAIL_ENABLED=true`, `CRM_OUTBOUND_EMAIL_PROVIDER=resend`, `CRM_OUTBOUND_EMAIL_FROM` with an explicitly authorized and provider-verified sender, and `CRM_OUTBOUND_EMAIL_API_KEY` for that provider account. Those credentials and sender ownership must be checked before activation. No variables have been set or enabled by this patch.

The patch preserves existing operator/audit permissions. Availability of a transport does not confer operator permissions on an audit-only superadmin or on another user. Existing authorized operators can reply once the transport is deliberately configured; broader role changes need their own authorization.

Current production Render credentials were not available through an authenticated CLI/API during this review; its exact missing variables remain unverified. The freshly pulled public-web Vercel configuration is a different environment and cannot prove the backend's provider readiness. The production UI report says email is disabled and WhatsApp awaits Meta. No message was sent, no data was modified, no new auth session was created, and browser-profile credentials were not extracted.

Tests use a fake transport and repository, proving configuration gates, authorization, confirmed and rejected delivery transitions, and uncertain/audit failures. Real provider deliverability is unverified until an authorized controlled test is explicitly requested.
