-- Run against a migrated local Supabase database as a database owner.
begin;

insert into auth.users (id, email) values
  ('e5cf7dc2-a889-4c36-aad4-010000000001', 'recovery1@example.test'),
  ('e5cf7dc2-a889-4c36-aad4-010000000002', 'recovery2@example.test'),
  ('e5cf7dc2-a889-4c36-aad4-010000000003', 'recovery3@example.test');

set local role authenticated;
do $$
declare
  first_user constant uuid := 'e5cf7dc2-a889-4c36-aad4-010000000001';
  second_user constant uuid := 'e5cf7dc2-a889-4c36-aad4-010000000002';
  replacement_user constant uuid := 'e5cf7dc2-a889-4c36-aad4-010000000003';
  first_key constant text := repeat('a', 64);
  second_key constant text := repeat('b', 64);
  result jsonb;
  agreement uuid;
  rejected boolean;
begin
  perform set_config('request.jwt.claim.sub', first_user::text, true);
  result := public.create_conflict_case('Test', 'pw', array['A', 'B'], 'A', first_key);
  if result->>'pace_status' <> 'calm' then raise exception 'Unexpected pace'; end if;
  insert into public.case_agreements (case_id, proposal_text)
  values ((result->>'id')::uuid, 'Agreement') returning id into agreement;

  perform set_config('request.jwt.claim.sub', second_user::text, true);
  rejected := false;
  begin
    perform public.join_conflict_case(result->>'case_code', 'pw', 'A', second_key);
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Incorrect key recovered another role'; end if;
  perform public.join_conflict_case(result->>'case_code', 'pw', 'B', second_key);
  rejected := false;
  begin
    perform public.join_conflict_case(result->>'case_code', 'pw', 'A', first_key);
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Existing member switched roles'; end if;

  perform set_config('request.jwt.claim.sub', replacement_user::text, true);
  perform public.join_conflict_case(lower(result->>'case_code'), 'pw', 'A', first_key);
  perform public.respond_to_agreement(agreement, true);
  perform set_config('request.jwt.claim.sub', first_user::text, true);
  if exists (select 1 from public.conflict_cases where id = (result->>'id')::uuid) then
    raise exception 'Former member retained access';
  end if;
  rejected := false;
  begin
    perform public.respond_to_agreement(agreement, true);
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Former member could sign'; end if;
  perform set_config('request.jwt.claim.sub', second_user::text, true);
  if public.respond_to_agreement(agreement, true)->>'status' <> 'accepted' then
    raise exception 'Agreement was not accepted';
  end if;
end;
$$;
rollback;
