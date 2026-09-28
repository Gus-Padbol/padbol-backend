-- Preparación del control idempotente para Apple Watch / Wear OS.
-- NO aplicar automáticamente: ejecutar primero en QA/local.
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

create or replace function scoreboard_apply_control_action(
  p_session_id uuid,
  p_action_id text,
  p_device_id text,
  p_expected_revision bigint,
  p_next_state jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session scoreboard_control_sessions%rowtype;
  v_board scoreboard_partidos%rowtype;
  v_previous scoreboard_control_actions%rowtype;
  v_response jsonb;
begin
  select * into v_session from scoreboard_control_sessions where id = p_session_id for update;
  if not found or v_session.revoked_at is not null or v_session.expires_at <= now() then
    raise exception 'CONTROL_SESSION_INACTIVE' using errcode = '28000';
  end if;
  if v_session.device_id <> p_device_id then
    raise exception 'CONTROL_DEVICE_MISMATCH' using errcode = '42501';
  end if;
  select * into v_previous from scoreboard_control_actions
    where session_id = p_session_id and action_id = p_action_id;
  if found then return v_previous.response || jsonb_build_object('deduplicated', true); end if;

  select * into v_board from scoreboard_partidos where id = v_session.scoreboard_id for update;
  if v_board.revision <> p_expected_revision then
    return jsonb_build_object('status','conflict','revision',v_board.revision);
  end if;
  update scoreboard_partidos set
    estado = p_next_state->>'estado', saque_actual = p_next_state->>'saque_actual',
    score_a = (p_next_state->>'score_a')::int, score_b = (p_next_state->>'score_b')::int,
    games_a = (p_next_state->>'games_a')::int, games_b = (p_next_state->>'games_b')::int,
    sets_a = (p_next_state->>'sets_a')::int, sets_b = (p_next_state->>'sets_b')::int,
    historial_sets = p_next_state->'historial_sets', es_tiebreak = (p_next_state->>'es_tiebreak')::boolean,
    ultimo_punto = p_next_state->>'ultimo_punto', historial_puntos = p_next_state->'historial_puntos',
    cronometro_inicio = nullif(p_next_state->>'cronometro_inicio','')::timestamptz,
    cronometro_pausado = (p_next_state->>'cronometro_pausado')::boolean,
    cronometro_segundos = (p_next_state->>'cronometro_segundos')::int,
    revision = revision + 1, updated_at = now()
  where id = v_board.id returning to_jsonb(scoreboard_partidos.*) into v_response;
  v_response := jsonb_build_object('status','applied','revision',p_expected_revision + 1,'scoreboard',v_response,'deduplicated',false);
  insert into scoreboard_control_actions(session_id,action_id,device_id,scoreboard_id,expected_revision,applied_revision,response)
    values(p_session_id,p_action_id,p_device_id,v_board.id,p_expected_revision,p_expected_revision+1,v_response);
  update scoreboard_control_sessions set last_seen_at=now() where id=p_session_id;
  return v_response;
end $$;

revoke all on function scoreboard_apply_control_action(uuid,text,text,bigint,jsonb) from public, anon, authenticated;
grant execute on function scoreboard_apply_control_action(uuid,text,text,bigint,jsonb) to service_role;

create or replace function scoreboard_claim_watch_pairing(
  p_pairing_code_hash text,
  p_device_id text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session scoreboard_control_sessions%rowtype;
  v_board scoreboard_partidos%rowtype;
  v_token text;
begin
  select * into v_session from scoreboard_control_sessions
    where pairing_code_hash = p_pairing_code_hash for update;
  if not found or v_session.pairing_claimed_at is not null
    or v_session.pairing_expires_at <= now() or v_session.expires_at <= now()
    or v_session.revoked_at is not null then
    return jsonb_build_object('status','invalid');
  end if;
  if p_device_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' then
    return jsonb_build_object('status','invalid');
  end if;
  v_token := translate(encode(gen_random_bytes(32), 'base64'), E'+/=\n', '-_');
  update scoreboard_control_sessions set
    device_id = p_device_id,
    token_hash = encode(digest(v_token, 'sha256'), 'hex'),
    pairing_claimed_at = now(), pairing_code_hash = null
    where id = v_session.id;
  select * into v_board from scoreboard_partidos where id = v_session.scoreboard_id;
  return jsonb_build_object(
    'status','claimed', 'control_token',v_token, 'scoreboard_id',v_session.scoreboard_id,
    'revision',v_board.revision, 'expires_at',v_session.expires_at
  );
end $$;

revoke all on function scoreboard_claim_watch_pairing(text,text) from public, anon, authenticated;
grant execute on function scoreboard_claim_watch_pairing(text,text) to service_role;
