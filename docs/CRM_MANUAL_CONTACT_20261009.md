# Manual CRM contact receipt

`POST /api/admin/crm/manual` requires the existing authenticated CRM operator permission. Audit-only superadmins and other users cannot register contacts. It accepts only `name`, optional `email`, and optional `phone`, with at least one valid contact identity. Existing authorization and operator lists remain unchanged.

The response is `{ok:true,existing:boolean,contact:{id,nombre,email_normalized,phone_normalized}}`. New rows return 201; an existing normalized identity returns 200 and its original persisted fields without overwriting them. Conflicting identities return 409. Database failures never claim successful storage. A unique-index race rereads the actual contact and returns it without updating its fields.

The UI must show the persisted receipt separately, including its reference ID, and explain when the contact already existed. This does not add an inbox conversation, send messages, register consent for marketing or assign a venue. Nonempty `origin`, `subject`, `body` or `sede_id` are rejected rather than silently discarding entered information.

Read-only production metadata confirms `crm_contacts` has only contact identity/name, review flag and timestamps. `crm_activities.conversation_id` is required. Therefore this patch does not fabricate an inbound email/WhatsApp conversation or a contact-only activity. No schema changes or real registrations were performed during implementation.

A future manual-history feature needs an explicitly reviewed model: either a dedicated contact-event table with actor/origin/notes and an appropriate read scope, or a reviewed change permitting contact-only activities while preserving existing conversation histories. Until that model is authorized and implemented, notes, origin, venue assignment and a separate manual-history listing remain unavailable. The current UI must not present those fields as saved.

Verification uses mock repositories and authenticated route stubs only; no provider is invoked.

Read-only production index metadata also confirms the existing partial unique indexes `uq_crm_contacts_email` and `uq_crm_contacts_phone`, so concurrent normalized registrations cannot create duplicate email/phone identities. No index or row was changed.
