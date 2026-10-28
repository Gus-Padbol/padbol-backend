-- Preparación del control idempotente para Apple Watch / Wear OS.
-- Probar localmente y aplicar en transacción antes de desplegar las rutas.
alter table scoreboard_partidos
  add column if not exists revision bigint not null default 0;

create table if not exists scoreboard_control_sessions (
  id uuid primary key default gen_random_uuid(),
  scoreboard_id uuid not null references scoreboard_partidos(id) on delete cascade,
  device_id text check (device_id is null or char_length(device_id) between 3 and 128),
  token_hash text unique,
  pairing_code_hash text unique,
  pairing_expires_at timestamptz,
  pairing_claimed_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
alter table scoreboard_control_sessions alter column device_id drop not null;
alter table scoreboard_control_sessions alter column token_hash drop not null;
alter table scoreboard_control_sessions add column if not exists pairing_code_hash text unique;
alter table scoreboard_control_sessions add column if not exists pairing_expires_at timestamptz;
alter table scoreboard_control_sessions add column if not exists pairing_claimed_at timestamptz;
create index if not exists idx_scoreboard_control_sessions_scoreboard
  on scoreboard_control_sessions(scoreboard_id);
alter table scoreboard_control_sessions enable row level security;
revoke all on scoreboard_control_sessions from anon, authenticated;

create table if not exists scoreboard_control_actions (
  session_id uuid not null references scoreboard_control_sessions(id) on delete cascade,
  action_id text not null,
  device_id text not null,
  scoreboard_id uuid not null references scoreboard_partidos(id) on delete cascade,
  expected_revision bigint not null,
  applied_revision bigint not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, action_id)
);
alter table scoreboard_control_actions enable row level security;
revoke all on scoreboard_control_actions from anon, authenticated;

create or replace function scoreboard_claim_watch_pairing(
  p_pairing_code_hash text,
  p_device_id text,
  p_control_token_hash text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session scoreboard_control_sessions%rowtype;
  v_board scoreboard_partidos%rowtype;
begin
  select * into v_session from scoreboard_control_sessions
    where pairing_code_hash = p_pairing_code_hash for update;
  if not found or v_session.pairing_claimed_at is not null
    or v_session.pairing_expires_at <= now() or v_session.expires_at <= now()
    or v_session.revoked_at is not null then
    return jsonb_build_object('status','invalid');
  end if;
  if p_control_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('status','invalid'); end if;
  if p_device_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' then
    return jsonb_build_object('status','invalid');
  end if;
  update scoreboard_control_sessions set
    device_id = p_device_id,
    token_hash = p_control_token_hash,
    pairing_claimed_at = now(), pairing_code_hash = null
    where id = v_session.id;
  select * into v_board from scoreboard_partidos where id = v_session.scoreboard_id;
  return jsonb_build_object(
    'status','claimed', 'scoreboard_id',v_session.scoreboard_id,
    'revision',v_board.revision, 'expires_at',v_session.expires_at
  );
end $$;

revoke all on function scoreboard_claim_watch_pairing(text,text,text) from public, anon, authenticated;
grant execute on function scoreboard_claim_watch_pairing(text,text,text) to service_role;

-- Preserve the existing timestamp/occupancy/history mutation protocol. All writers
-- also advance a Watch revision; no older scoring function is replaced.
CREATE OR REPLACE FUNCTION public.scoreboard_advance_watch_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS scoreboard_advance_watch_revision ON public.scoreboard_partidos;
CREATE TRIGGER scoreboard_advance_watch_revision BEFORE UPDATE ON public.scoreboard_partidos
FOR EACH ROW EXECUTE FUNCTION public.scoreboard_advance_watch_revision();
REVOKE ALL ON FUNCTION public.scoreboard_advance_watch_revision() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.scoreboard_apply_watch_action(
 p_session_id uuid,p_action_id text,p_device_id text,p_expected_revision bigint,
 p_expected_updated_at timestamptz,p_next jsonb,p_kind text,p_history jsonb,p_history_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.scoreboard_control_sessions%ROWTYPE;
 b public.scoreboard_partidos%ROWTYPE; previous public.scoreboard_control_actions%ROWTYPE;
 result jsonb; response jsonb;
BEGIN
 SELECT * INTO s FROM public.scoreboard_control_sessions WHERE id=p_session_id FOR UPDATE;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at<=now() OR s.device_id IS NULL
  THEN RAISE EXCEPTION 'CONTROL_SESSION_INACTIVE' USING ERRCODE='28000'; END IF;
 IF s.device_id IS DISTINCT FROM p_device_id
  THEN RAISE EXCEPTION 'CONTROL_DEVICE_MISMATCH' USING ERRCODE='42501'; END IF;
 SELECT * INTO previous FROM public.scoreboard_control_actions WHERE session_id=p_session_id AND action_id=p_action_id;
 IF FOUND THEN RETURN previous.response || jsonb_build_object('deduplicated',true); END IF;
 -- Match the existing occupancy-before-board lock order to avoid deadlocks.
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 SELECT * INTO b FROM public.scoreboard_partidos WHERE id=s.scoreboard_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SCOREBOARD_NOT_FOUND'; END IF;
 IF b.revision<>p_expected_revision OR b.updated_at IS DISTINCT FROM p_expected_updated_at
  THEN RETURN jsonb_build_object('status','conflict','revision',b.revision); END IF;
 result:=public.scoreboard_commit_mutation(b.id,p_expected_updated_at,p_next,p_kind,p_history,p_history_id);
 IF result IS NULL THEN RETURN jsonb_build_object('status','conflict','revision',b.revision); END IF;
 response:=jsonb_build_object('status','applied','revision',(result->>'revision')::bigint,'scoreboard',result,'deduplicated',false);
 INSERT INTO public.scoreboard_control_actions(session_id,action_id,device_id,scoreboard_id,expected_revision,applied_revision,response)
 VALUES(s.id,p_action_id,p_device_id,b.id,p_expected_revision,(result->>'revision')::bigint,response);
 UPDATE public.scoreboard_control_sessions SET last_seen_at=now() WHERE id=s.id;
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_apply_watch_action(uuid,text,text,bigint,timestamptz,jsonb,text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_apply_watch_action(uuid,text,text,bigint,timestamptz,jsonb,text,jsonb,uuid) TO service_role;
