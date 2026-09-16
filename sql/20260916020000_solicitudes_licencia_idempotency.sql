-- Idempotencia opcional para reintentos del formulario público.
-- El servidor persiste sólo SHA-256 del Idempotency-Key, nunca el valor original.
begin;

alter table public.solicitudes_licencia
  add column if not exists idempotency_key text;

alter table public.solicitudes_licencia
  add constraint solicitudes_licencia_idempotency_key_check
    check (idempotency_key is null or idempotency_key ~ '^[a-f0-9]{64}$');

create unique index if not exists uq_solicitudes_licencia_idempotency_key
  on public.solicitudes_licencia (idempotency_key)
  where idempotency_key is not null;

commit;
