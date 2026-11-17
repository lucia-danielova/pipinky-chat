-- Run against a migrated local Supabase database as a database owner.
begin;

insert into auth.users (id, email)
values ('e5cf7dc2-a889-4c36-aad4-020000000001', 'pace@example.test');

do $$
declare
  member_id constant uuid := 'e5cf7dc2-a889-4c36-aad4-020000000001';
  case_data jsonb;
  reservation jsonb;
  result jsonb := '{
    "summary": "Spomaľme.",
    "pace_status": "slow_down",
    "safety_alert": true,
    "agreement_proposal": null,
    "updated_memory": {"facts": ["Fakt"], "open_questions": ["Otázka"]}
  }'::jsonb;
  rejected boolean := false;
begin
  perform set_config('request.jwt.claim.sub', member_id::text, true);
  case_data := public.create_conflict_case(
    'Test', 'pw', array['A', 'B'], 'A', repeat('a', 64)
  );
  reservation := public.reserve_mediator_request((case_data->>'id')::uuid, member_id, 'mediate');
  begin
    perform public.publish_mediator_result(
      (case_data->>'id')::uuid, member_id, (reservation->>'request_id')::uuid,
      result || '{"agreement_proposal": "Dohoda"}'::jsonb
    );
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Agreement allowed despite safety alert'; end if;
  perform public.publish_mediator_result(
    (case_data->>'id')::uuid, member_id, (reservation->>'request_id')::uuid, result
  );
  if not exists (
    select 1 from public.conflict_cases
    where id = (case_data->>'id')::uuid and pace_status = 'slow_down'
      and temperature_score = 20
      and case_memory->'facts' = '["Fakt"]'::jsonb
      and case_memory->'needs' = '{}'::jsonb
  ) then raise exception 'Pace or memory not updated correctly'; end if;
  if not exists (
    select 1 from public.chat_messages
    where case_id = (case_data->>'id')::uuid and message_type = 'mediator'
      and structured_data->'safety_alert' = 'true'::jsonb
  ) then raise exception 'Safety alert not published'; end if;
  if exists (select 1 from public.case_agreements where case_id = (case_data->>'id')::uuid) then
    raise exception 'Unexpected agreement';
  end if;
  if has_function_privilege('authenticated',
    'public.publish_mediator_result(uuid,uuid,uuid,jsonb)', 'execute') then
    raise exception 'Publication exposed to authenticated users';
  end if;
end;
$$;
rollback;
