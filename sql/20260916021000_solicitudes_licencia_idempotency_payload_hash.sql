-- Vincula cada Idempotency-Key con el contenido exacto de la solicitud.
begin;

alter table public.solicitudes_licencia
  add column if not exists idempotency_payload_hash text;

alter table public.solicitudes_licencia
  add constraint solicitudes_licencia_idempotency_payload_hash_check
    check (idempotency_payload_hash is null or idempotency_payload_hash ~ '^[a-f0-9]{64}$');

alter table public.solicitudes_licencia
  add constraint solicitudes_licencia_idempotency_pair_check
    check ((idempotency_key is null) = (idempotency_payload_hash is null)) not valid;

commit;
