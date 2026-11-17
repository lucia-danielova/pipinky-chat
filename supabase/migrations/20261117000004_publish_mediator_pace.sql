create or replace function public.publish_mediator_result(
  p_case_id uuid, p_user_id uuid, p_request_id uuid, p_result jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement_id uuid;
  v_summary text := p_result ->> 'summary';
  v_proposal text := p_result ->> 'agreement_proposal';
begin
  perform 1 from public.mediator_case_limits
  where case_id = p_case_id and request_id = p_request_id for update;
  if not found then
    raise exception 'Mediator request is no longer current';
  end if;
  perform 1 from public.case_members
  where case_id = p_case_id and user_id = p_user_id for key share;
  if not found then
    raise exception 'Case membership is required';
  end if;
  if v_summary is null or char_length(btrim(v_summary)) not between 1 and 2000
    or jsonb_typeof(p_result -> 'updated_memory') is distinct from 'object'
    or coalesce(p_result ->> 'pace_status', '') not in ('calm', 'active', 'slow_down')
    or jsonb_typeof(p_result -> 'safety_alert') is distinct from 'boolean'
    or ((p_result ->> 'safety_alert')::boolean and
      (p_result ->> 'pace_status' <> 'slow_down' or v_proposal is not null))
    or (v_proposal is not null and char_length(btrim(v_proposal)) not between 1 and 4000) then
    raise exception 'Invalid mediator result';
  end if;

  update public.conflict_cases
  set pace_status = p_result ->> 'pace_status',
      case_memory = case_memory || (p_result -> 'updated_memory')
  where id = p_case_id;
  if not found then
    raise exception 'Case not found';
  end if;

  if v_proposal is not null then
    insert into public.case_agreements (case_id, proposal_text)
    values (p_case_id, v_proposal)
    returning id into v_agreement_id;
  end if;
  insert into public.chat_messages (
    case_id, sender_id, sender_name, message, is_mediator,
    message_type, agreement_id, structured_data
  ) values (
    p_case_id, null, 'Mediátor', v_summary, true,
    case when v_agreement_id is null then 'mediator' else 'agreement' end,
    v_agreement_id, p_result
  );
  update public.mediator_case_limits
  set request_id = gen_random_uuid()
  where case_id = p_case_id;

  return v_agreement_id;
end;
$$;
