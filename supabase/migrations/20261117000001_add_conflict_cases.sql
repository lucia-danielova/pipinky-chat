create extension if not exists pgcrypto with schema extensions;

create table public.conflict_cases (
  id uuid primary key default gen_random_uuid(),
  case_code text unique not null default (
    'MED-' || upper(substr(encode(extensions.gen_random_bytes(3), 'hex'), 1, 6))
  ),
  title text not null check (char_length(btrim(title)) between 2 and 100),
  password_hash text not null,
  participants text[] not null check (
    array_ndims(participants) = 1
    and cardinality(participants) between 2 and 8
    and array_position(participants, null) is null
  ),
  phase text not null default 'intake'
    check (phase in ('intake', 'exploration', 'needs', 'compromise', 'resolved')),
  case_memory jsonb not null default '{"facts": [], "needs": {}, "open_questions": []}'::jsonb,
  temperature_score int not null default 20 check (temperature_score between 0 and 100),
  created_at timestamptz not null default now()
);

create table public.case_members (
  case_id uuid references public.conflict_cases(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  participant_name text not null,
  joined_at timestamptz not null default now(),
  primary key (case_id, user_id),
  unique (case_id, participant_name)
);

create table public.case_agreements (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.conflict_cases(id) on delete cascade,
  proposal_text text not null,
  accepted_by text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now()
);

create index case_members_user_id_idx on public.case_members (user_id, case_id);
create index case_agreements_case_id_idx on public.case_agreements (case_id);

-- Preserve the old global chat without exposing it through the new case-based API.
create table public.chat_messages_legacy_archive as table public.chat_messages;
revoke all on public.chat_messages_legacy_archive from public, anon, authenticated;
grant select on public.chat_messages_legacy_archive to service_role;
delete from public.chat_messages;

alter table public.chat_messages
  add column case_id uuid not null references public.conflict_cases(id) on delete cascade,
  add column message_type text not null default 'chat'
    check (message_type in ('chat', 'mediator', 'agreement', 'system')),
  add column structured_data jsonb,
  add column agreement_id uuid references public.case_agreements(id) on delete set null;

create index chat_messages_case_id_id_idx on public.chat_messages (case_id, id);
create index chat_messages_sender_created_at_idx
  on public.chat_messages (sender_id, created_at desc) where not is_mediator;

alter table public.conflict_cases enable row level security;
alter table public.case_members enable row level security;
alter table public.case_agreements enable row level security;
alter table public.chat_messages_legacy_archive enable row level security;

revoke all on public.conflict_cases, public.case_members, public.case_agreements
  from public, anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
grant select (id, case_code, title, participants, phase, case_memory, temperature_score, created_at)
  on public.conflict_cases to authenticated;
grant select on public.case_members, public.case_agreements to authenticated;
grant insert (case_id, proposal_text) on public.case_agreements to authenticated;
grant select on public.chat_messages to authenticated;
grant insert (case_id, sender_id, message) on public.chat_messages to authenticated;

create function public.is_case_member(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.case_members
    where case_id = p_case_id and user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_case_member(uuid) from public, anon;
grant execute on function public.is_case_member(uuid) to authenticated;

create policy "Members can read cases"
  on public.conflict_cases for select to authenticated
  using (public.is_case_member(id));

create policy "Members can read case members"
  on public.case_members for select to authenticated
  using (public.is_case_member(case_id));

create policy "Members can read agreements"
  on public.case_agreements for select to authenticated
  using (public.is_case_member(case_id));

create policy "Members can propose agreements"
  on public.case_agreements for insert to authenticated
  with check (public.is_case_member(case_id));

drop policy "Authenticated users can read chat messages" on public.chat_messages;
drop policy "Users can insert their own messages" on public.chat_messages;

create policy "Members can read case messages"
  on public.chat_messages for select to authenticated
  using (public.is_case_member(case_id));

create policy "Members can send case messages"
  on public.chat_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and not is_mediator
    and message_type = 'chat'
    and public.is_case_member(case_id)
  );

create or replace function public.set_chat_message_sender_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  last_msg_time timestamptz;
begin
  new.message := btrim(new.message);
  if new.message = '' then
    raise exception 'Správa nemôže byť prázdna.';
  end if;

  if new.agreement_id is not null and not exists (
    select 1 from public.case_agreements
    where id = new.agreement_id and case_id = new.case_id
  ) then
    raise exception 'Agreement does not belong to this case';
  end if;

  if new.is_mediator then
    if new.message_type = 'chat' then
      new.message_type := 'mediator';
    end if;
    return new;
  end if;
  if auth.uid() is null and new.sender_id is null
    and new.message_type in ('mediator', 'agreement', 'system') then
    return new;
  end if;

  select participant_name into new.sender_name
  from public.case_members
  where case_id = new.case_id and user_id = auth.uid();

  if new.sender_name is null or new.sender_id is distinct from auth.uid() then
    raise exception 'Case membership is required to send messages';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(auth.uid()::text, 0)
  );
  select message.created_at into last_msg_time
  from public.chat_messages as message
  where message.sender_id = auth.uid() and not message.is_mediator
  order by message.created_at desc
  limit 1;

  if last_msg_time is not null and pg_catalog.clock_timestamp() - last_msg_time < interval '1 second' then
    raise exception 'Posielaš správy príliš rýchlo. Počkaj chvíľu.';
  end if;
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

create function public.create_conflict_case(
  p_title text, p_password text, p_participants text[], p_creator_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.conflict_cases%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_password is null or p_password = '' or octet_length(p_password) > 72 then
    raise exception 'Password must be between 1 and 72 bytes';
  end if;
  if p_participants is null or array_ndims(p_participants) is distinct from 1
    or cardinality(p_participants) not between 2 and 8
    or exists (
      select 1 from unnest(p_participants) as name
      where name is null or name = '' or name <> btrim(name)
    )
    or (select count(distinct name) from unnest(p_participants) as name) <> cardinality(p_participants)
    or p_creator_name is null or not (p_creator_name = any(p_participants)) then
    raise exception 'Participants must have distinct, non-empty names and include the creator';
  end if;

  loop
    insert into public.conflict_cases (title, password_hash, participants)
    values (btrim(p_title), extensions.crypt(p_password, extensions.gen_salt('bf')), p_participants)
    on conflict (case_code) do nothing
    returning * into v_case;
    exit when found;
  end loop;

  insert into public.case_members (case_id, user_id, participant_name)
  values (v_case.id, auth.uid(), p_creator_name);

  return jsonb_build_object(
    'id', v_case.id, 'case_code', v_case.case_code, 'title', v_case.title,
    'participants', v_case.participants, 'phase', v_case.phase,
    'temperature_score', v_case.temperature_score
  );
end;
$$;

create function public.join_conflict_case(
  p_case_code text, p_password text, p_participant_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.conflict_cases%rowtype;
  v_existing_name text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_password is null or p_password = '' or octet_length(p_password) > 72 then
    raise exception 'Invalid case code or password';
  end if;

  select * into v_case from public.conflict_cases
  where case_code = p_case_code
  for update;
  if not found or extensions.crypt(p_password, v_case.password_hash) <> v_case.password_hash then
    raise exception 'Invalid case code or password';
  end if;

  v_result := jsonb_build_object(
    'id', v_case.id, 'case_code', v_case.case_code, 'title', v_case.title,
    'participants', v_case.participants, 'phase', v_case.phase,
    'temperature_score', v_case.temperature_score
  );
  if p_participant_name is null then
    return v_result || jsonb_build_object(
      'occupied_names', coalesce(
        (select jsonb_agg(participant_name order by participant_name)
         from public.case_members where case_id = v_case.id), '[]'::jsonb
      )
    );
  end if;

  if not (p_participant_name = any(v_case.participants)) then
    raise exception 'Participant name is not listed in this case';
  end if;
  select participant_name into v_existing_name from public.case_members
  where case_id = v_case.id and user_id = auth.uid();
  if found then
    if v_existing_name <> p_participant_name then
      raise exception 'You have already joined this case under another name';
    end if;
  else
    if exists (
      select 1 from public.case_members
      where case_id = v_case.id and participant_name = p_participant_name
    ) then
      raise exception 'Participant name is already occupied';
    end if;
    insert into public.case_members (case_id, user_id, participant_name)
    values (v_case.id, auth.uid(), p_participant_name);
  end if;
  return v_result;
end;
$$;

create function public.respond_to_agreement(p_agreement_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.case_agreements%rowtype;
  v_name text;
  v_participants text[];
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_accept is null then
    raise exception 'Agreement response is required';
  end if;
  select * into v_agreement from public.case_agreements
  where id = p_agreement_id for update;
  if not found then
    raise exception 'Agreement not found';
  end if;
  select member.participant_name, cases.participants into v_name, v_participants
  from public.case_members as member
  join public.conflict_cases as cases on cases.id = member.case_id
  where member.case_id = v_agreement.case_id and member.user_id = auth.uid();
  if not found then
    raise exception 'Case membership is required';
  end if;
  if v_agreement.status <> 'pending' then
    raise exception 'Agreement is no longer pending';
  end if;

  if p_accept then
    if not (v_name = any(v_agreement.accepted_by)) then
      v_agreement.accepted_by := array_append(v_agreement.accepted_by, v_name);
    end if;
    if v_participants <@ v_agreement.accepted_by then
      v_agreement.status := 'accepted';
      update public.conflict_cases set phase = 'resolved' where id = v_agreement.case_id;
    end if;
  else
    v_agreement.status := 'rejected';
  end if;
  update public.case_agreements
  set accepted_by = v_agreement.accepted_by, status = v_agreement.status
  where id = v_agreement.id;
  return jsonb_build_object(
    'id', v_agreement.id, 'case_id', v_agreement.case_id,
    'proposal_text', v_agreement.proposal_text,
    'accepted_by', v_agreement.accepted_by, 'status', v_agreement.status,
    'created_at', v_agreement.created_at
  );
end;
$$;

revoke all on function public.create_conflict_case(text, text, text[], text) from public, anon;
revoke all on function public.join_conflict_case(text, text, text) from public, anon;
revoke all on function public.respond_to_agreement(uuid, boolean) from public, anon;
grant execute on function public.create_conflict_case(text, text, text[], text) to authenticated;
grant execute on function public.join_conflict_case(text, text, text) to authenticated;
grant execute on function public.respond_to_agreement(uuid, boolean) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'conflict_cases'
  ) then
    alter publication supabase_realtime add table public.conflict_cases;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'case_agreements'
  ) then
    alter publication supabase_realtime add table public.case_agreements;
  end if;
end;
$$;
