# CRM outbound email adapter (prepared, not activated)

The previous CRM reply service rejected every non-WhatsApp conversation before looking for an email transport. Changing only environment flags could not restore email replies. This patch injects an explicit sender callback, exposes `emailSendEnabled` in operator permissions and records a reply as pending before provider delivery. Provider acceptance with a message identifier marks it sent; explicit rejection marks it cancelled. Network uncertainty, a provider 5xx or a failed audit update leaves it pending with a warning, rather than claiming that delivery did not happen.

The implemented provider is Resend, already used by the backend for invitations. SMTP is not implemented and therefore is not reported as enabled merely because `SMTP_URL` is present. The adapter has no default sender, destination contact, credentials or automated sweep. Reply-To now defaults to the existing company inbox info@padbol.com. It uses the conversation's stored contact email and the persisted reply ID as the provider idempotency key.

Required operational configuration: `BACKEND_RUNTIME_MODE=production`, `OUTBOUND_DELIVERY_ENABLED=true`, `CRM_OUTBOUND_EMAIL_ENABLED=true`, `CRM_OUTBOUND_EMAIL_PROVIDER=resend`, `CRM_OUTBOUND_EMAIL_FROM` with an explicitly authorized and provider-verified sender, `CRM_OUTBOUND_EMAIL_API_KEY` for that provider account, and optionally `CRM_OUTBOUND_EMAIL_REPLY_TO` to override the verified company reply mailbox info@padbol.com. An explicitly malformed override fails closed. Those credentials and sender ownership must be checked before activation. No variables have been set or enabled by this patch.

The patch preserves existing operator/audit permissions. Availability of a transport does not confer operator permissions on an audit-only superadmin or on another user. Existing authorized operators can reply once the transport is deliberately configured; broader role changes need their own authorization.

Current production Render credentials were not available through an authenticated CLI/API during this review; its exact missing variables remain unverified. The freshly pulled public-web Vercel configuration is a different environment and cannot prove the backend's provider readiness. The production UI report says email is disabled and WhatsApp awaits Meta. No message was sent, no data was modified, no new auth session was created, and browser-profile credentials were not extracted.

Tests use a fake transport and repository, proving configuration gates, authorization, confirmed and rejected delivery transitions, and uncertain/audit failures. Real provider deliverability is unverified until an authorized controlled test is explicitly requested.

Email replies require a UUID `requestId` in the reply POST. The frontend must retain it for retries of the same composition, and replace it after success or when composing another response. A deterministic UUID scoped to the conversation claims the existing `crm_replies` primary key atomically before contacting the provider. A replay of a sent request returns its prior result; a pending or cancelled request returns 409 without delivery. Reusing a reference with a different body or operator also returns 409. Separate compositions can contain identical text using different references. No schema migration is required for this claim.

Email audit updates require persistence of `provider_message_id`; they do not fall back to dropping that identifier when the column is unavailable. WhatsApp's existing compatibility behavior is preserved.


## Reply routing and operational verification

The provider-verified `From` address does not prove that it can receive replies.
Configure `CRM_OUTBOUND_EMAIL_REPLY_TO` only after confirming ownership, reception,
and the intended mailbox workflow. It is sent as Resend's `reply_to` field and
never inferred from a browser-supplied operator or conversation field. Existing
messages already sent cannot be updated by changing this configuration.

If replies must appear inside the CRM, an enabled, configured inbound adapter
and verified conversation correlation are separate requirements. The current
IMAP adapter imports each message as an independent institutional-email
conversation; this sender change alone neither links it to the commercial lead
nor grants commercial access. Do not describe provider acceptance (`sent`) as
confirmed delivery or a completed two-way email conversation. No production
mailbox, credentials, or flags are changed by this patch.


## Actualización del 28/10/2026

Los envíos existentes siguen habilitados y ahora indican como dirección de respuesta `info@padbol.com`, un buzón existente comprobado en Gmail. El destinatario del envío continúa siendo el contacto de la ficha; no se toma una dirección enviada por el navegador. No se modificaron los cinco correos históricos ni se reenviaron mensajes a clientes.

El retorno a la ficha requiere además recepción IMAP y confirmaciones autenticadas de Resend para relacionar el RFC Message-ID. La clave de envío actual no permite recuperar mensajes por GET: no se debe inferir ese identificador a partir del UUID de Resend. Los envíos antiguos requieren recuperar sus identificadores desde el panel oficial o mediante lectura autorizada, sin reenviarlos.

Servidor IMAP comprobado por DNS y TLS: `c239.ferozo.com:993`, mismo IP del correo actual, certificado válido y TLS1.3. `mail.padbol.com` devuelve un certificado cuyo nombre no coincide: no desactivar la verificación TLS para usar ese nombre. No se intentó iniciar sesión ni adivinar contraseñas.

Configuración protegida de recepción: `CRM_INBOUND_IMAP_ENABLED=true`, `CRM_INBOUND_IMAP_HOST=c239.ferozo.com`, puerto993, conexión segura, usuario y destinatario esperado `info@padbol.com`; la contraseña solo debe cargarse en el almacenamiento protegido del servidor. `CRM_OUTBOUND_EMAIL_REPLY_TO=info@padbol.com` documenta explícitamente el retorno.

Configurar un webhook Resend hacia `/api/crm/email/provider-events` para email.sent/delivered/bounced/failed/complained, guardar su secreto de firma en `CRM_EMAIL_PROVIDER_WEBHOOK_SECRET` y activar `CRM_EMAIL_RETURN_ENABLED` después de aplicar las migraciones y verificar la recepción. El código verifica la firma con Svix sobre los bytes originales; no acepta eventos anónimos ni vincula hilos únicamente por remitente/asunto.

La correspondencia entrante y saliente se consulta mediante endpoints que revalidan el acceso a la ficha antes y después de leer, y se presenta en el CRM sin traducción. Una aceptación del proveedor no se presenta como entrega ni como lectura. El cuerpo de texto conserva el límite actual de4000 caracteres del esquema CRM; no se afirma recuperación de mensajes originales históricos más largos.
