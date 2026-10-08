-- QA critical RLS remediation for five tables exposed through the public schema.
-- The FIPA catalog keeps read-only access to deliberate public rows.
-- Historical-player and audit data remain backend-only through service_role.

begin;

revoke all on table
  public.fipa_asociaciones_nacionales,
  public.fipa_temporadas,
  public.fipa_ranking_excepciones_auditoria,
  public.jugador_claim_historico,
  public.jugador_historico
from public, anon, authenticated;

revoke all on sequence
  public.fipa_asociaciones_nacionales_id_seq,
  public.fipa_temporadas_id_seq,
  public.fipa_ranking_excepciones_auditoria_id_seq,
  public.jugador_claim_historico_id_seq,
  public.jugador_historico_id_seq
from public, anon, authenticated;

alter table public.fipa_asociaciones_nacionales enable row level security;
alter table public.fipa_temporadas enable row level security;
alter table public.fipa_ranking_excepciones_auditoria enable row level security;
alter table public.jugador_claim_historico enable row level security;
alter table public.jugador_historico enable row level security;

drop policy if exists fipa_asociaciones_activas_lectura_publica
  on public.fipa_asociaciones_nacionales;
drop policy if exists fipa_temporadas_publicadas_lectura_publica
  on public.fipa_temporadas;

grant select on table public.fipa_asociaciones_nacionales to anon, authenticated;
create policy fipa_asociaciones_activas_lectura_publica
  on public.fipa_asociaciones_nacionales
  for select
  to anon, authenticated
  using (activa is true);

grant select on table public.fipa_temporadas to anon, authenticated;
create policy fipa_temporadas_publicadas_lectura_publica
  on public.fipa_temporadas
  for select
  to anon, authenticated
  using (estado = 'publicada');

-- No direct anon/authenticated policies are created for the audit, claim, or
-- historical-player tables. Legitimate access stays behind backend
-- authentication/authorization and the server-side service_role client.

commit;
