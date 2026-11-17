create extension if not exists pgcrypto with schema extensions;

alter table public.conflict_cases
  add column pace_status text not null default 'calm'
    check (pace_status in ('calm', 'active', 'slow_down'));
grant select (pace_status) on public.conflict_cases to authenticated;

-- Keep reservations independently of auth.users, which may be deleted.
create table public.case_recovery_keys (
  case_id uuid not null references public.conflict_cases(id) on delete cascade,
  participant_name text not null,
  key_hash bytea,
  primary key (case_id, participant_name)
);
alter table public.case_recovery_keys enable row level security;
revoke all on public.case_recovery_keys from public, anon, authenticated;

insert into public.case_recovery_keys (case_id, participant_name)
select case_id, participant_name from public.case_members;

drop function public.create_conflict_case(text, text, text[], text);
create function public.create_conflict_case(
  p_title text, p_password text, p_participants text[], p_creator_name text,
  p_recovery_key text
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
  if p_recovery_key is null or p_recovery_key !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid recovery key is required';
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
  insert into public.case_recovery_keys (case_id, participant_name, key_hash)
  values (v_case.id, p_creator_name, extensions.digest(p_recovery_key, 'sha256'));

  return jsonb_build_object(
    'id', v_case.id, 'case_code', v_case.case_code, 'title', v_case.title,
    'participants', v_case.participants, 'phase', v_case.phase,
    'temperature_score', v_case.temperature_score, 'pace_status', v_case.pace_status
  );
end;
$$;

drop function public.join_conflict_case(text, text, text);
create function public.join_conflict_case(
  p_case_code text, p_password text, p_participant_name text default null,
  p_recovery_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.conflict_cases%rowtype;
  v_existing_name text;
  v_owner uuid;
  v_hash bytea;
  v_reserved boolean;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_password is null or p_password = '' or octet_length(p_password) > 72 then
    raise exception 'Invalid case code or password';
  end if;
  select * into v_case from public.conflict_cases
  where case_code = upper(btrim(p_case_code))
  for update;
  if not found or extensions.crypt(p_password, v_case.password_hash) <> v_case.password_hash then
    raise exception 'Invalid case code or password';
  end if;
  v_result := jsonb_build_object(
    'id', v_case.id, 'case_code', v_case.case_code, 'title', v_case.title,
    'participants', v_case.participants, 'phase', v_case.phase,
    'temperature_score', v_case.temperature_score, 'pace_status', v_case.pace_status
  );
  if p_participant_name is null then
    return v_result || jsonb_build_object(
      'occupied_names', coalesce(
        (select jsonb_agg(participant_name order by participant_name)
         from public.case_recovery_keys where case_id = v_case.id), '[]'::jsonb
      )
    );
  end if;
  if not (p_participant_name = any(v_case.participants)) then
    raise exception 'Participant name is not listed in this case';
  end if;
  select participant_name into v_existing_name from public.case_members
  where case_id = v_case.id and user_id = auth.uid();
  if found and v_existing_name <> p_participant_name then
    raise exception 'You have already joined this case under another name';
  end if;

  select key_hash into v_hash from public.case_recovery_keys
  where case_id = v_case.id and participant_name = p_participant_name;
  v_reserved := found;
  select user_id into v_owner from public.case_members
  where case_id = v_case.id and participant_name = p_participant_name;

  if v_owner = auth.uid() then
    if v_hash is null and p_recovery_key is not null then
      if p_recovery_key !~ '^[0-9a-f]{64}$' then
        raise exception 'A valid recovery key is required';
      end if;
      update public.case_recovery_keys
      set key_hash = extensions.digest(p_recovery_key, 'sha256')
      where case_id = v_case.id and participant_name = p_participant_name;
    elsif p_recovery_key is not null and
      (p_recovery_key !~ '^[0-9a-f]{64}$'
       or v_hash <> extensions.digest(p_recovery_key, 'sha256')) then
      raise exception 'Invalid recovery key or unavailable participant';
    end if;
    return v_result;
  end if;

  if p_recovery_key is null or p_recovery_key !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid recovery key is required';
  end if;
  if v_reserved then
    if v_hash is null or v_hash <> extensions.digest(p_recovery_key, 'sha256') then
      raise exception 'Invalid recovery key or unavailable participant';
    end if;
    update public.case_members set user_id = auth.uid(), joined_at = now()
    where case_id = v_case.id and participant_name = p_participant_name;
    if not found then
      insert into public.case_members (case_id, user_id, participant_name)
      values (v_case.id, auth.uid(), p_participant_name);
    end if;
  else
    insert into public.case_members (case_id, user_id, participant_name)
    values (v_case.id, auth.uid(), p_participant_name);
    insert into public.case_recovery_keys (case_id, participant_name, key_hash)
    values (v_case.id, p_participant_name, extensions.digest(p_recovery_key, 'sha256'));
  end if;
  return v_result;
end;
$$;

revoke all on function public.create_conflict_case(text, text, text[], text, text) from public, anon;
revoke all on function public.join_conflict_case(text, text, text, text) from public, anon;
grant execute on function public.create_conflict_case(text, text, text[], text, text) to authenticated;
grant execute on function public.join_conflict_case(text, text, text, text) to authenticated;
