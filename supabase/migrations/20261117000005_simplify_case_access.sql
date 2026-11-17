drop function public.create_conflict_case(text, text, text[], text, text);
drop function public.join_conflict_case(text, text, text, text);

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
    'temperature_score', v_case.temperature_score, 'pace_status', v_case.pace_status
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
         from public.case_members where case_id = v_case.id), '[]'::jsonb
      )
    );
  end if;
  if not (p_participant_name = any(v_case.participants)) then
    raise exception 'Participant name is not listed in this case';
  end if;

  delete from public.case_members
  where case_id = v_case.id and user_id = auth.uid()
    and participant_name <> p_participant_name;

  insert into public.case_members (case_id, user_id, participant_name)
  values (v_case.id, auth.uid(), p_participant_name)
  on conflict (case_id, participant_name)
  do update set user_id = excluded.user_id, joined_at = now();

  return v_result;
end;
$$;

revoke all on function public.create_conflict_case(text, text, text[], text) from public, anon;
revoke all on function public.join_conflict_case(text, text, text) from public, anon;
grant execute on function public.create_conflict_case(text, text, text[], text) to authenticated;
grant execute on function public.join_conflict_case(text, text, text) to authenticated;
