create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id bigint generated always as identity primary key,
  sender_id uuid references public.profiles (id) on delete set null,
  sender_name text not null,
  message text not null check (char_length(message) between 1 and 2000),
  is_mediator boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.chat_messages enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.chat_messages to authenticated;
grant insert (sender_id, message) on public.chat_messages to authenticated;
grant usage, select on sequence public.chat_messages_id_seq to authenticated;

create policy "Authenticated users can read profiles"
  on public.profiles for select to authenticated
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "Authenticated users can read chat messages"
  on public.chat_messages for select to authenticated
  using (true);

create policy "Users can insert their own messages"
  on public.chat_messages for insert to authenticated
  with check (
    (select auth.uid()) = sender_id
    and is_mediator = false
  );

create function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_display_name text;
begin
  new_display_name := nullif(btrim(new.raw_user_meta_data ->> 'display_name'), '');
  if new_display_name is null then
    new_display_name := split_part(coalesce(new.email, 'user'), '@', 1);
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, left(new_display_name, 40));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

insert into public.profiles (id, display_name)
select id, left(coalesce(
  nullif(btrim(raw_user_meta_data ->> 'display_name'), ''),
  nullif(split_part(coalesce(email, ''), '@', 1), ''),
  'Používateľ'
), 40)
from auth.users;

create function public.set_chat_message_sender_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_mediator then
    return new;
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

create trigger set_chat_message_sender_name_before_insert
  before insert on public.chat_messages
  for each row execute procedure public.set_chat_message_sender_name();

do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end;
$$;
