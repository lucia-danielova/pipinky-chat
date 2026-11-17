create or replace function public.set_chat_message_sender_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  last_msg_time timestamptz;
begin
  if new.is_mediator then
    return new;
  end if;

  new.message := btrim(new.message);
  if new.message = '' then
    raise exception 'Správa nemôže byť prázdna.';
  end if;

  select message.created_at
    into last_msg_time
    from public.chat_messages as message
    where message.sender_id = auth.uid()
      and not message.is_mediator
    order by message.created_at desc
    limit 1;

  if last_msg_time is not null and now() - last_msg_time < interval '1 second' then
    raise exception 'Posielaš správy príliš rýchlo. Počkaj chvíľu.';
  end if;

  select profile.display_name
    into new.sender_name
    from public.profiles as profile
    where profile.id = auth.uid();

  if new.sender_name is null then
    raise exception 'A chat profile is required to send messages';
  end if;

  return new;
end;
$$;
