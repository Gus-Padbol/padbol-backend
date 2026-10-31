
 create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table public.crm_conversations(id uuid primary key,source_channel text not null check(source_channel in ('email','whatsapp')));
 create table public.crm_replies(id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.crm_conversations(id) on delete cascade,body text not null,operador text,status text default 'pending' check(status in ('pending','sent','cancelled')),provider_message_id text,
 constraint crm_replies_body_check check(length(trim(body)) between 1 and 4096));
 create table public.crm_commercial_advisors(user_id uuid primary key);
 create table public.crm_commercial_form_cases(conversation_id uuid primary key,assigned_user_id uuid,progress_state text);
 create table public.crm_commercial_form_send_attempts(reply_id uuid primary key,conversation_id uuid,actor_id uuid,status text);
 create function public.crm_commercial_form_is_allowed(id uuid) returns boolean language sql as $$select exists(select 1 from public.crm_conversations where crm_conversations.id=$1 and source_channel='email')$$;
 create function public.crm_commercial_team_case_allowed(actor uuid,superadmin boolean,assigned uuid) returns boolean language sql as $$select actor=assigned or superadmin$$;
 insert into auth.users values('33333333-3333-4333-8333-333333333333','fixture@example.invalid',now()),('44444444-4444-4444-8444-444444444444','other@example.invalid',now());
 insert into public.crm_conversations values('11111111-1111-4111-8111-111111111111','email'),('22222222-2222-4222-8222-222222222222','whatsapp');
 insert into public.crm_commercial_advisors values('33333333-3333-4333-8333-333333333333');
 insert into public.crm_commercial_form_cases values('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','nuevo');
 insert into public.crm_replies(conversation_id,body,status) values('11111111-1111-4111-8111-111111111111','preserved historical message','sent');
 
 create table public.crm_whatsapp_manual_attempts(reply_id uuid constraint crm_whatsapp_manual_attempts_reply_id_fkey references public.crm_replies(id) on delete restrict);
 create table public.crm_whatsapp_menu_events(reply_id uuid constraint crm_whatsapp_menu_events_reply_id_fkey references public.crm_replies(id));
 create table public.crm_commercial_case_replies(reply_id uuid constraint crm_commercial_case_replies_reply_id_fkey references public.crm_replies(id) on delete restrict);
 create table public.crm_commercial_case_send_attempts(reply_id uuid constraint crm_commercial_case_send_attempts_reply_id_fkey references public.crm_replies(id) on delete restrict);
 alter table public.crm_commercial_form_send_attempts add constraint crm_commercial_form_send_attempts_reply_id_fkey foreign key(reply_id) references public.crm_replies(id) on delete restrict;
 create table public.crm_email_provider_receipts(reply_id uuid constraint crm_email_provider_receipts_reply_id_fkey references public.crm_replies(id) on delete cascade);
