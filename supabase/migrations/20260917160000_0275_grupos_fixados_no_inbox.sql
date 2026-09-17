-- Grupos fixados são preferência individual: uma pessoa não reorganiza o inbox da outra.
create table if not exists public.conversation_group_pins (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, conversation_id)
);
create index if not exists conversation_group_pins_user_idx on public.conversation_group_pins (organization_id, user_id, created_at desc);
alter table public.conversation_group_pins enable row level security;
drop policy if exists conversation_group_pins_own on public.conversation_group_pins;
create policy conversation_group_pins_own on public.conversation_group_pins for all using (
  organization_id in (select public.fn_user_org_ids()) and user_id = auth.uid()
) with check (
  organization_id in (select public.fn_user_org_ids()) and user_id = auth.uid()
  and exists (select 1 from public.conversations c where c.id = conversation_id and c.organization_id = organization_id and c.is_group)
);
revoke all on public.conversation_group_pins from anon, public;
grant select, insert, delete on public.conversation_group_pins to authenticated;
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
comment on table public.conversation_group_pins is 'Grupos fixados no Inbox, privados por usuário e organização.';
