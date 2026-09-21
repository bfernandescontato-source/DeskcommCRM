-- Central de Disparos — NÚCLEO (0280): campanha de WhatsApp com fila persistente.
--
-- O QUE ESTA MIGRATION É. O banco vira a fonte da verdade de uma campanha: cada
-- contato tem o próprio estado, e pausar, retomar, trocar a mensagem e trocar o
-- grupo de destino são operações do banco — não do processo que por acaso está
-- rodando. Reiniciar o app, a VPS ou o worker não perde posição nem repete envio.
--
-- ─── AS QUATRO REGRAS QUE O DESENHO PROTEGE ────────────────────────────────────
--
--  1. UM CONTATO, UMA LINHA POR CAMPANHA. `unique (campaign_id, contact_id)`: nem
--     um segundo import nem um duplo-clique cria a pessoa duas vezes.
--
--  2. ENVIAR SÓ SAI DE UM ESTADO, POR UMA PORTA. pending -> queued (reserva do
--     lote, `for update skip locked`) -> processing (`fn_campaign_begin_send`, o
--     ponto sem volta) -> sent. Cada passo confere o `claim_token`: quem perdeu a
--     reserva descobre isso pelo retorno `lost`, não por um envio em dobro.
--
--  3. "SÓ OS PRÓXIMOS". A versão da mensagem e o destino valem no instante do
--     `begin_send`, lidos com a linha da campanha travada `for share`; trocar
--     versão/destino trava a mesma linha (`for no key update`). Quem já estava em
--     `processing` manteve o que viu; todo `begin_send` depois vê o novo. Não há
--     janela em que os dois valem.
--
--  4. NUNCA REENVIAR NO ESCURO. Worker que morre com o contato em `processing`
--     deixa a lease vencer e o varredor o marca `uncertain` — nunca volta para
--     `pending`. Não existe exactly-once no WhatsApp; um envio em dobro é pior que
--     um envio a menos, e a decisão é de uma pessoa.
--
-- ─── STATUS DE ENTREGA x ENGAJAMENTO ───────────────────────────────────────────
--
-- `status` diz o que aconteceu com o ENVIO (pending…sent/failed). Clique,
-- resposta, entrada e saída de grupo NÃO são status: a Maria pode estar `sent`,
-- ter clicado, respondido e entrado no grupo ao mesmo tempo. São carimbos
-- (`clicked_at`, `replied_at`, `joined_at`, `left_at`) — projeções de
-- `campaign_events`, gravadas na mesma transação que o evento.
--
-- ─── O QUE FICA DE FORA DAQUI (e onde entra) ───────────────────────────────────
--   importação de CSV (campaign_imports)          -> 0281
--   rastreio de clique (campaign_clicks)          -> 0282
--   entrada/saída de grupo (group_membership_*)   -> 0283
-- Tabela sem consumidor é o anti-pattern nº 3 do CLAUDE.md: cada uma nasce com o
-- código que a lê.
--
-- ─── SEGURANÇA ─────────────────────────────────────────────────────────────────
-- Toda tabela tem RLS por organização e o navegador só LÊ (grant select). Toda
-- escrita passa por função `security definer` executável só pelo `service_role`
-- (as duas origens de EXECUTE revogadas), chamada por rota que já resolveu papel
-- e organização de fonte confiável. `campaign_events` é append-only até para o
-- `service_role`, como `api_audit_log` (0258): "nunca apagar o histórico" é
-- propriedade do schema, não de quem escreve a rota.

-- ═══ A. TABELAS ═══════════════════════════════════════════════════════════════

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  status text not null default 'draft'
    check (status in ('draft','ready','running','paused','completed','cancelled','error')),
  -- Por que está pausada / em erro ('manual', 'no_channel', 'no_destination'…).
  status_reason text check (status_reason is null or char_length(status_reason) <= 120),
  active_version_id uuid,
  active_destination_id uuid,
  -- Rastreio liga o {{link_grupo}} ao redirecionador interno (0282); desligado, o
  -- link do grupo vai cru na mensagem.
  tracking_enabled boolean not null default true,
  -- O que fazer quando um canal cai no meio: seguir com os outros ou parar tudo.
  channel_policy text not null default 'skip_channel'
    check (channel_policy in ('skip_channel','pause_campaign')),
  -- Sobe a cada mudança de estado/ponteiro. Serve à tela para detectar "mudou
  -- enquanto eu olhava", e ao teste para provar que a mudança aconteceu.
  revision integer not null default 1,
  started_at timestamptz,
  paused_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table if not exists public.campaign_message_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  version_no integer not null check (version_no >= 1),
  -- 4096 é o teto de texto do WhatsApp. O texto guarda as variáveis
  -- ({{nome}}, {{link_grupo}}…) cruas: quem as resolve é o envio, por contato.
  body text not null check (char_length(btrim(body)) between 1 and 4096),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- `activated_at` nulo = versão salva e ainda não em uso (o operador respondeu
  -- "não" a "aplicar aos próximos contatos?"). `superseded_at` = deixou de ser a ativa.
  activated_at timestamptz,
  superseded_at timestamptz,
  unique (campaign_id, version_no),
  unique (id, campaign_id),
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade
);

create table if not exists public.campaign_destinations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  -- BLACK #01, #02…: a ordem em que o grupo foi cadastrado na campanha.
  sequence_no integer not null check (sequence_no >= 1),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  invite_url text not null
    check (char_length(invite_url) <= 2048 and invite_url ~ '^https://[^[:space:]]+$'),
  -- Preenchido quando o grupo é um que o CRM enxerga (…@g.us): é o que permite,
  -- depois (0283), reconhecer entrada e saída. Sem ele o destino só mede clique.
  group_chat_id text check (group_chat_id is null or group_chat_id ~ '^[0-9-]+@g\.us$'),
  capacity integer check (capacity is null or capacity between 1 and 100000),
  status text not null default 'queued' check (status in ('queued','active','closed')),
  opened_at timestamptz,
  closed_at timestamptz,
  close_reason text check (close_reason is null or close_reason in ('full','manual','campaign_ended')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, sequence_no),
  unique (id, campaign_id),
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade,
  check ((status = 'closed') = (closed_at is not null)),
  check (status <> 'closed' or close_reason is not null),
  check (status <> 'queued' or opened_at is null)
);

-- No máximo UM destino ativo por campanha — é o que "trocar destino" garante.
create unique index if not exists uniq_campaign_destinations_one_active
  on public.campaign_destinations (campaign_id) where status = 'active';

-- Os dois ponteiros da campanha. FK COMPOSTA `(ponteiro, id)`: o destino/versão
-- ativo tem de ser DESTA campanha — o banco recusa apontar para o de outra.
do $f$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaigns_active_version_fk') then
    alter table public.campaigns add constraint campaigns_active_version_fk
      foreign key (active_version_id, id)
      references public.campaign_message_versions (id, campaign_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_active_destination_fk') then
    alter table public.campaigns add constraint campaigns_active_destination_fk
      foreign key (active_destination_id, id)
      references public.campaign_destinations (id, campaign_id);
  end if;
end $f$;

create table if not exists public.campaign_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  -- RESTRICT como em `messages`: número que já enviou campanha não some do histórico.
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,
  enabled boolean not null default true,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, channel_session_id),
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade
);

create table if not exists public.campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  -- RESTRICT (como conversations/messages): a pessoa é anonimizada, não apagada.
  contact_id uuid not null references public.contacts(id) on delete restrict,
  -- Ordem da fila. Identity, não timestamp: importar 45 mil linhas num só
  -- statement dá o mesmo `now()` a todas.
  seq bigint generated always as identity,
  status text not null default 'pending'
    check (status in ('pending','queued','processing','sent','failed','uncertain','skipped','cancelled')),
  skip_reason text
    check (skip_reason is null or skip_reason in ('blocked','no_phone','declined_marketing','anonymized','merged')),
  -- Preenchidos no envio, não na importação: respondem "qual número, qual
  -- versão e qual grupo ESTA pessoa recebeu".
  channel_session_id uuid references public.channel_sessions(id) on delete restrict,
  message_version_id uuid,
  destination_id uuid,
  message_id uuid references public.messages(id) on delete set null,
  -- Público, não sequencial, sem nada interno (usado em /g/<token> na 0282).
  tracking_token text not null default left(replace(gen_random_uuid()::text, '-', ''), 20),
  claim_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 64),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  -- Colunas extras do CSV ({{produto}}…). Bag de chave/valor por desenho; é dado
  -- pessoal em potencial e por isso é ZERADA na anonimização do contato (abaixo).
  variables jsonb not null default '{}'::jsonb check (jsonb_typeof(variables) = 'object'),
  sent_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id),
  unique (tracking_token),
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade,
  foreign key (message_version_id, campaign_id)
    references public.campaign_message_versions (id, campaign_id),
  foreign key (destination_id, campaign_id)
    references public.campaign_destinations (id, campaign_id),
  -- Reservado/em envio => tem dono e prazo. Pendente => sem dono.
  check (status not in ('queued','processing') or (claim_token is not null and lease_expires_at is not null)),
  check (status <> 'pending' or (claim_token is null and lease_expires_at is null)),
  check (status <> 'sent' or sent_at is not null),
  check ((status = 'skipped') = (skip_reason is not null))
);

-- A fila: o próximo pendente de uma campanha, em ordem.
create index if not exists idx_campaign_contacts_pending
  on public.campaign_contacts (campaign_id, seq) where status = 'pending';
-- O varredor de leases vencidas.
create index if not exists idx_campaign_contacts_lease
  on public.campaign_contacts (lease_expires_at) where status in ('queued','processing');
-- A aba Fila: filtro por status, paginada por `seq`.
create index if not exists idx_campaign_contacts_status
  on public.campaign_contacts (campaign_id, status, seq);
-- "Em que campanhas esta pessoa está?" (perfil do contato, resposta do Inbox).
create index if not exists idx_campaign_contacts_contact
  on public.campaign_contacts (organization_id, contact_id);
-- Métricas e filtros por versão, destino e número.
create index if not exists idx_campaign_contacts_version
  on public.campaign_contacts (campaign_id, message_version_id) where message_version_id is not null;
create index if not exists idx_campaign_contacts_destination
  on public.campaign_contacts (campaign_id, destination_id) where destination_id is not null;
create index if not exists idx_campaign_contacts_channel
  on public.campaign_contacts (campaign_id, channel_session_id) where channel_session_id is not null;
create index if not exists idx_campaign_contacts_message
  on public.campaign_contacts (message_id) where message_id is not null;
create index if not exists idx_campaign_channels_session
  on public.campaign_channels (channel_session_id);

create table if not exists public.campaign_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  -- Nulo = evento da campanha; preenchido = linha do tempo daquele contato.
  campaign_contact_id uuid references public.campaign_contacts(id) on delete cascade,
  kind text not null check (kind in (
    'created','ready','started','paused','resumed','completed','cancelled','errored',
    'imported','settings_changed',
    'version_created','version_activated',
    'destination_added','destination_changed',
    'channel_added','channel_removed',
    'sent','send_failed','uncertain','skipped',
    'clicked','replied','joined','left','removed'
  )),
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references auth.users(id) on delete set null,
  -- O que estava valendo QUANDO aconteceu (versão, grupo e número do momento).
  message_version_id uuid,
  destination_id uuid,
  channel_session_id uuid,
  -- Antes/depois e detalhes. Pequeno por desenho; sem dado pessoal.
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  -- Evento repetido (webhook em dobro, retry) não duplica: mesma chave, uma linha.
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) <= 200),
  created_at timestamptz not null default now(),
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade
);

create unique index if not exists uniq_campaign_events_idempotency
  on public.campaign_events (campaign_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_campaign_events_campaign
  on public.campaign_events (campaign_id, occurred_at desc);
create index if not exists idx_campaign_events_contact
  on public.campaign_events (campaign_contact_id, occurred_at) where campaign_contact_id is not null;

-- ═══ B. INVARIANTES QUE A LINHA SOZINHA NÃO EXPRESSA ═════════════════════════

-- Versão é imutável: "nunca modificar retroativamente o histórico". Só os
-- carimbos de ativação mudam.
create or replace function public.fn_campaign_version_imutavel()
returns trigger language plpgsql set search_path = public as $f$
begin
  if new.body is distinct from old.body
     or new.version_no is distinct from old.version_no
     or new.campaign_id is distinct from old.campaign_id
     or new.organization_id is distinct from old.organization_id then
    raise exception 'campaign_version_immutable' using errcode = 'P0001';
  end if;
  return new;
end $f$;

drop trigger if exists trg_campaign_version_imutavel on public.campaign_message_versions;
create trigger trg_campaign_version_imutavel
  before update on public.campaign_message_versions
  for each row execute function public.fn_campaign_version_imutavel();

drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.fn_set_updated_at();

-- LGPD: as colunas extras do CSV são dado pessoal em potencial. Quando o contato é
-- anonimizado, o que veio da planilha some junto (o histórico do envio fica).
create or replace function public.fn_redigir_disparos_do_contato_anonimizado()
returns trigger language plpgsql security definer set search_path = public as $f$
begin
  update public.campaign_contacts
     set variables = '{}'::jsonb, last_error = null, updated_at = now()
   where contact_id = new.id;
  return null;
end $f$;

drop trigger if exists trg_redigir_disparos_ao_anonimizar on public.contacts;
create trigger trg_redigir_disparos_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_disparos_do_contato_anonimizado();

-- ═══ C. RLS E PRIVILÉGIOS ═════════════════════════════════════════════════════
-- O navegador só LÊ. Escrever é com o servidor (service_role) via as funções da
-- seção D — que conferem organização e estado.

do $f$
declare t text;
begin
  foreach t in array array['campaigns','campaign_message_versions','campaign_destinations',
                           'campaign_channels','campaign_contacts','campaign_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_' || t || '_all', t);
    execute format(
      'create policy %I on public.%I for all using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()) with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())',
      'tenant_isolation_' || t || '_all', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $f$;

-- Append-only para os papéis do PostgREST — inclusive service_role. O cascade da
-- exclusão de uma campanha rascunho roda como dono da tabela e não é afetado.
revoke update, delete, truncate on public.campaign_events from anon, authenticated, service_role;
revoke delete, truncate on public.campaign_message_versions from anon, authenticated, service_role;

-- ═══ D. FUNÇÕES ═══════════════════════════════════════════════════════════════
-- Todas: security definer, search_path fixo, EXECUTE só do service_role. Erros são
-- códigos estáveis em `message` (a rota os traduz); P0002 = não achou, P0001 = regra.

-- D1. Registro de evento (interna). Idempotente pela chave.
create or replace function public.fn_campaign_log(
  p_org uuid, p_campaign uuid, p_kind text, p_actor uuid default null,
  p_campaign_contact uuid default null, p_version uuid default null,
  p_destination uuid default null, p_channel uuid default null,
  p_payload jsonb default '{}'::jsonb, p_key text default null
) returns void language plpgsql security definer set search_path = public as $f$
begin
  insert into public.campaign_events (
    organization_id, campaign_id, campaign_contact_id, kind, actor_user_id,
    message_version_id, destination_id, channel_session_id, payload, idempotency_key)
  values (
    p_org, p_campaign, p_campaign_contact, p_kind, p_actor,
    p_version, p_destination, p_channel, coalesce(p_payload, '{}'::jsonb), p_key)
  on conflict (campaign_id, idempotency_key) where idempotency_key is not null do nothing;
end $f$;

-- D2. Criar campanha (rascunho).
create or replace function public.fn_campaign_create(
  p_org uuid, p_name text, p_actor uuid default null,
  p_tracking_enabled boolean default true, p_channel_policy text default 'skip_channel'
) returns uuid language plpgsql security definer set search_path = public as $f$
declare v_id uuid;
begin
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'campaign_org_not_found' using errcode = 'P0002';
  end if;
  insert into public.campaigns (organization_id, name, tracking_enabled, channel_policy, created_by)
  values (p_org, btrim(p_name), coalesce(p_tracking_enabled, true),
          coalesce(p_channel_policy, 'skip_channel'), p_actor)
  returning id into v_id;
  perform public.fn_campaign_log(p_org, v_id, 'created', p_actor, null, null, null, null,
    jsonb_build_object('name', btrim(p_name)));
  return v_id;
end $f$;

-- D3. Configurações da campanha, com antes/depois no evento.
create or replace function public.fn_campaign_update_settings(
  p_org uuid, p_campaign uuid, p_actor uuid default null,
  p_name text default null, p_tracking_enabled boolean default null, p_channel_policy text default null
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare c public.campaigns%rowtype; v_changes jsonb := '{}'::jsonb;
begin
  select * into c from public.campaigns
   where id = p_campaign and organization_id = p_org for no key update;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if c.status in ('completed','cancelled') then
    raise exception 'campaign_closed' using errcode = 'P0001';
  end if;
  if p_name is not null and btrim(p_name) <> c.name then
    v_changes := v_changes || jsonb_build_object('name', jsonb_build_object('from', c.name, 'to', btrim(p_name)));
  end if;
  if p_tracking_enabled is not null and p_tracking_enabled <> c.tracking_enabled then
    v_changes := v_changes || jsonb_build_object('tracking_enabled', jsonb_build_object('from', c.tracking_enabled, 'to', p_tracking_enabled));
  end if;
  if p_channel_policy is not null and p_channel_policy <> c.channel_policy then
    v_changes := v_changes || jsonb_build_object('channel_policy', jsonb_build_object('from', c.channel_policy, 'to', p_channel_policy));
  end if;
  if v_changes = '{}'::jsonb then
    return jsonb_build_object('changed', false);
  end if;
  update public.campaigns
     set name = coalesce(btrim(p_name), name),
         tracking_enabled = coalesce(p_tracking_enabled, tracking_enabled),
         channel_policy = coalesce(p_channel_policy, channel_policy),
         revision = revision + 1
   where id = p_campaign;
  perform public.fn_campaign_log(p_org, p_campaign, 'settings_changed', p_actor, null, null, null, null, v_changes);
  return jsonb_build_object('changed', true, 'changes', v_changes);
end $f$;

-- D4. Canais da campanha: o conjunto HABILITADO passa a ser exatamente o informado.
-- Só WhatsApp por sessão (provider waha); número arquivado ou de outra organização é recusado.
create or replace function public.fn_campaign_set_channels(
  p_org uuid, p_campaign uuid, p_channels uuid[], p_actor uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  v_status text; v_wanted uuid[]; v_added uuid[]; v_removed uuid[]; ch uuid;
begin
  select status into v_status from public.campaigns
   where id = p_campaign and organization_id = p_org for no key update;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if v_status in ('completed','cancelled') then
    raise exception 'campaign_closed' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_wanted from unnest(coalesce(p_channels, '{}'::uuid[])) x;

  if exists (
    select 1 from unnest(v_wanted) w(id)
     where not exists (
       select 1 from public.channel_sessions s
        where s.id = w.id and s.organization_id = p_org
          and s.provider = 'waha' and s.archived_at is null)
  ) then
    raise exception 'campaign_invalid_channel' using errcode = 'P0001';
  end if;

  with off as (
    update public.campaign_channels set enabled = false
     where campaign_id = p_campaign and enabled and not (channel_session_id = any (v_wanted))
    returning channel_session_id)
  select coalesce(array_agg(channel_session_id), '{}'::uuid[]) into v_removed from off;

  with on_ as (
    insert into public.campaign_channels (organization_id, campaign_id, channel_session_id, enabled, added_by)
    select p_org, p_campaign, w, true, p_actor from unnest(v_wanted) w
    on conflict (campaign_id, channel_session_id)
      do update set enabled = true where public.campaign_channels.enabled = false
    returning channel_session_id)
  select coalesce(array_agg(channel_session_id), '{}'::uuid[]) into v_added from on_;

  foreach ch in array v_added loop
    perform public.fn_campaign_log(p_org, p_campaign, 'channel_added', p_actor, null, null, null, ch);
  end loop;
  foreach ch in array v_removed loop
    perform public.fn_campaign_log(p_org, p_campaign, 'channel_removed', p_actor, null, null, null, ch);
  end loop;

  return jsonb_build_object('added', coalesce(array_length(v_added, 1), 0),
                            'removed', coalesce(array_length(v_removed, 1), 0));
end $f$;

-- D5. Nova versão da mensagem. `p_based_on_version_no` é a última versão que a tela
-- viu: se outra pessoa criou uma depois, recusa (`campaign_version_conflict`) em vez
-- de sobrescrever em silêncio. `p_activate = false` guarda a versão sem usá-la.
create or replace function public.fn_campaign_create_version(
  p_org uuid, p_campaign uuid, p_body text, p_actor uuid default null,
  p_activate boolean default true, p_based_on_version_no integer default null
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  c public.campaigns%rowtype; v_no integer; v_id uuid; v_prev_no integer;
begin
  select * into c from public.campaigns
   where id = p_campaign and organization_id = p_org for no key update;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if c.status in ('completed','cancelled') then
    raise exception 'campaign_closed' using errcode = 'P0001';
  end if;

  select coalesce(max(version_no), 0) into v_no
    from public.campaign_message_versions where campaign_id = p_campaign;
  if p_based_on_version_no is not null and p_based_on_version_no <> v_no then
    raise exception 'campaign_version_conflict' using errcode = 'P0001',
      detail = format('current=%s', v_no);
  end if;
  v_no := v_no + 1;

  insert into public.campaign_message_versions (organization_id, campaign_id, version_no, body, created_by)
  values (p_org, p_campaign, v_no, p_body, p_actor)
  returning id into v_id;

  perform public.fn_campaign_log(p_org, p_campaign, 'version_created', p_actor, null, v_id, null, null,
    jsonb_build_object('version_no', v_no, 'activated', coalesce(p_activate, true)));

  if coalesce(p_activate, true) then
    if c.active_version_id is not null then
      select version_no into v_prev_no from public.campaign_message_versions where id = c.active_version_id;
      update public.campaign_message_versions set superseded_at = now()
       where id = c.active_version_id and superseded_at is null;
    end if;
    update public.campaign_message_versions set activated_at = now() where id = v_id;
    update public.campaigns set active_version_id = v_id, revision = revision + 1 where id = p_campaign;
    perform public.fn_campaign_log(p_org, p_campaign, 'version_activated', p_actor, null, v_id, null, null,
      jsonb_build_object('from_version_no', v_prev_no, 'to_version_no', v_no));
  end if;

  return jsonb_build_object('version_id', v_id, 'version_no', v_no,
                            'activated', coalesce(p_activate, true), 'previous_version_no', v_prev_no);
end $f$;

-- D6. Trocar o destino ativo. Fecha o atual, abre o novo e move o ponteiro numa
-- transação só; contatos já enviados guardam o destino que receberam. Repetir a
-- troca para o destino que já é o ativo não faz nada. `p_expected_current` é o
-- destino que a tela achava ser o ativo (recusa se mudou: `campaign_destination_conflict`).
create or replace function public.fn_campaign_switch_destination(
  p_org uuid, p_campaign uuid, p_destination uuid, p_actor uuid default null,
  p_close_reason text default 'full', p_expected_current uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  c public.campaigns%rowtype; d public.campaign_destinations%rowtype; cur public.campaign_destinations%rowtype;
begin
  select * into c from public.campaigns
   where id = p_campaign and organization_id = p_org for no key update;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if c.status in ('completed','cancelled') then
    raise exception 'campaign_closed' using errcode = 'P0001';
  end if;

  select * into d from public.campaign_destinations
   where id = p_destination and campaign_id = p_campaign;
  if not found then raise exception 'campaign_destination_not_found' using errcode = 'P0002'; end if;

  if p_expected_current is not null and c.active_destination_id is distinct from p_expected_current then
    raise exception 'campaign_destination_conflict' using errcode = 'P0001';
  end if;
  if c.active_destination_id = d.id then
    return jsonb_build_object('changed', false, 'destination_id', d.id);
  end if;
  if d.status = 'closed' then
    raise exception 'campaign_destination_closed' using errcode = 'P0001';
  end if;

  if c.active_destination_id is not null then
    select * into cur from public.campaign_destinations where id = c.active_destination_id;
    update public.campaign_destinations
       set status = 'closed', closed_at = now(), close_reason = coalesce(p_close_reason, 'manual')
     where id = cur.id;
  end if;
  update public.campaign_destinations set status = 'active', opened_at = now() where id = d.id;
  update public.campaigns set active_destination_id = d.id, revision = revision + 1 where id = p_campaign;

  perform public.fn_campaign_log(p_org, p_campaign, 'destination_changed', p_actor, null, null, d.id, null,
    jsonb_build_object('from_destination_id', cur.id, 'from_name', cur.name,
                       'to_destination_id', d.id, 'to_name', d.name,
                       'close_reason', case when cur.id is null then null else coalesce(p_close_reason, 'manual') end));
  return jsonb_build_object('changed', true, 'destination_id', d.id, 'previous_destination_id', cur.id);
end $f$;

-- D7. Cadastrar destino (e, se pedido, já torná-lo o ativo — "cadastrar e trocar").
create or replace function public.fn_campaign_add_destination(
  p_org uuid, p_campaign uuid, p_name text, p_invite_url text,
  p_group_chat_id text default null, p_capacity integer default null, p_actor uuid default null,
  p_activate boolean default false, p_expected_current uuid default null,
  p_close_reason text default 'full'
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_status text; v_no integer; v_id uuid; v_switch jsonb;
begin
  select status into v_status from public.campaigns
   where id = p_campaign and organization_id = p_org for no key update;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  if v_status in ('completed','cancelled') then
    raise exception 'campaign_closed' using errcode = 'P0001';
  end if;

  select coalesce(max(sequence_no), 0) + 1 into v_no
    from public.campaign_destinations where campaign_id = p_campaign;
  insert into public.campaign_destinations
    (organization_id, campaign_id, sequence_no, name, invite_url, group_chat_id, capacity, created_by)
  values (p_org, p_campaign, v_no, btrim(p_name), btrim(p_invite_url), p_group_chat_id, p_capacity, p_actor)
  returning id into v_id;

  perform public.fn_campaign_log(p_org, p_campaign, 'destination_added', p_actor, null, null, v_id, null,
    jsonb_build_object('name', btrim(p_name), 'sequence_no', v_no, 'capacity', p_capacity));

  if coalesce(p_activate, false) then
    v_switch := public.fn_campaign_switch_destination(
      p_org, p_campaign, v_id, p_actor, p_close_reason, p_expected_current);
  end if;
  return jsonb_build_object('destination_id', v_id, 'sequence_no', v_no,
                            'activated', coalesce(p_activate, false), 'switch', v_switch);
end $f$;

-- D8. O que uma campanha precisa ter para começar (interna). A ordem dos erros é a
-- dos passos do assistente — contatos, mensagem, destino, canais — para que o
-- primeiro que falta seja também o primeiro passo que a pessoa precisa voltar a fazer.
create or replace function public.fn_campaign_assert_startable(p_campaign uuid, p_need_contacts boolean)
returns void language plpgsql security definer set search_path = public as $f$
declare c public.campaigns%rowtype; v_body text;
begin
  select * into c from public.campaigns where id = p_campaign;
  if p_need_contacts and not exists (
    select 1 from public.campaign_contacts where campaign_id = p_campaign and status = 'pending') then
    raise exception 'campaign_no_contacts' using errcode = 'P0001';
  end if;
  if c.active_version_id is null then
    raise exception 'campaign_no_message' using errcode = 'P0001';
  end if;
  select body into v_body from public.campaign_message_versions where id = c.active_version_id;
  if c.active_destination_id is null and v_body ~ '\{\{\s*link_grupo\s*\}\}' then
    raise exception 'campaign_no_destination' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.campaign_channels where campaign_id = p_campaign and enabled) then
    raise exception 'campaign_no_channel' using errcode = 'P0001';
  end if;
end $f$;

-- D9. A máquina de estados da campanha. Idempotente: pedir o estado em que ela já
-- está devolve `changed: false`. Terminais (completed/cancelled) não saem de lá.
-- ENCERRAR e CANCELAR cancelam o que ainda não saiu; o que já foi enviado, e o
-- histórico inteiro, ficam.
create or replace function public.fn_campaign_transition(
  p_org uuid, p_campaign uuid, p_action text, p_actor uuid default null, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  c public.campaigns%rowtype; v_to text; v_kind text; v_cancelled integer := 0;
begin
  if p_action not in ('ready','start','pause','resume','complete','cancel','fail') then
    raise exception 'campaign_invalid_action' using errcode = 'P0001';
  end if;
  select * into c from public.campaigns
   where id = p_campaign and organization_id = p_org for no key update;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;

  v_to := case p_action
    when 'ready' then 'ready' when 'start' then 'running' when 'pause' then 'paused'
    when 'resume' then 'running' when 'complete' then 'completed' when 'cancel' then 'cancelled'
    when 'fail' then 'error' end;
  v_kind := case p_action
    when 'ready' then 'ready' when 'start' then 'started' when 'pause' then 'paused'
    when 'resume' then 'resumed' when 'complete' then 'completed' when 'cancel' then 'cancelled'
    when 'fail' then 'errored' end;

  if c.status = v_to then
    return jsonb_build_object('changed', false, 'from', c.status, 'to', v_to);
  end if;

  if not (
       (p_action = 'ready'    and c.status = 'draft')
    or (p_action = 'start'    and c.status in ('draft','ready'))
    or (p_action = 'pause'    and c.status = 'running')
    or (p_action = 'resume'   and c.status in ('paused','error'))
    or (p_action = 'complete' and c.status in ('running','paused','error'))
    or (p_action = 'cancel'   and c.status in ('draft','ready','running','paused','error'))
    or (p_action = 'fail'     and c.status = 'running')
  ) then
    raise exception 'campaign_invalid_transition' using errcode = 'P0001',
      detail = format('%s -> %s', c.status, v_to);
  end if;

  if p_action in ('ready','start') then
    perform public.fn_campaign_assert_startable(p_campaign, true);
  elsif p_action = 'resume' then
    perform public.fn_campaign_assert_startable(p_campaign, false);
  end if;

  if p_action in ('complete','cancel') then
    update public.campaign_contacts
       set status = 'cancelled', claim_token = null, lease_expires_at = null,
           channel_session_id = null, updated_at = now()
     where campaign_id = p_campaign and status in ('pending','queued');
    get diagnostics v_cancelled = row_count;
    -- O destino que estava recebendo é encerrado junto: a campanha acabou.
    update public.campaign_destinations
       set status = 'closed', closed_at = now(), close_reason = 'campaign_ended'
     where campaign_id = p_campaign and status = 'active';
  end if;

  update public.campaigns
     set status = v_to,
         status_reason = case when v_to in ('paused','error') then coalesce(p_reason, 'manual') else null end,
         started_at = case when p_action = 'start' then now() else started_at end,
         paused_at = case when v_to = 'paused' then now() else paused_at end,
         finished_at = case when v_to in ('completed','cancelled') then now() else finished_at end,
         revision = revision + 1
   where id = p_campaign;

  perform public.fn_campaign_log(p_org, p_campaign, v_kind, p_actor, null, null, null, null,
    jsonb_build_object('from', c.status, 'to', v_to, 'reason', p_reason, 'cancelled_contacts', v_cancelled));
  return jsonb_build_object('changed', true, 'from', c.status, 'to', v_to, 'cancelled_contacts', v_cancelled);
end $f$;

-- D10. Reservar o próximo lote de um número. Só devolve linhas com a campanha em
-- RUNNING, o número habilitado na campanha e conectado (WORKING, não arquivado) —
-- pausar tem efeito na próxima reserva. `for update skip locked`: dois workers nunca
-- pegam o mesmo contato. A versão e o destino NÃO são fixados aqui, e sim no begin_send.
create or replace function public.fn_campaign_claim_batch(
  p_org uuid, p_campaign uuid, p_channel uuid, p_limit integer default 10, p_lease_seconds integer default 90
) returns table (campaign_contact_id uuid, contact_id uuid, claim_token uuid)
language plpgsql security definer set search_path = public as $f$
declare
  v_status text; v_token uuid := gen_random_uuid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 200));
begin
  select c.status into v_status from public.campaigns c
   where c.id = p_campaign and c.organization_id = p_org for share;
  if v_status is distinct from 'running' then return; end if;
  if not exists (select 1 from public.campaign_channels ch
                  where ch.campaign_id = p_campaign and ch.channel_session_id = p_channel and ch.enabled) then
    return;
  end if;
  if not exists (select 1 from public.channel_sessions s
                  where s.id = p_channel and s.organization_id = p_org
                    and s.status = 'WORKING' and s.archived_at is null) then
    return;
  end if;

  return query
  with picked as (
    select cc.id from public.campaign_contacts cc
     where cc.campaign_id = p_campaign and cc.status = 'pending'
       and (cc.next_attempt_at is null or cc.next_attempt_at <= now())
     order by cc.seq
     limit v_limit
     for update skip locked
  ), upd as (
    update public.campaign_contacts cc
       set status = 'queued', claim_token = v_token,
           lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 90), 15)),
           channel_session_id = p_channel, updated_at = now()
      from picked where cc.id = picked.id
    returning cc.id, cc.contact_id, cc.claim_token, cc.seq
  )
  select upd.id, upd.contact_id, upd.claim_token from upd order by upd.seq;
end $f$;

-- D11. O ponto sem volta. Devolve `decision`:
--   send                o worker PODE enviar (o contato está `processing`, com a versão
--                       e o destino de AGORA já gravados)
--   released            campanha não está mais rodando: o contato voltou a `pending`
--   channel_unavailable o número saiu da campanha ou desconectou: voltou a `pending`
--   no_destination      a mensagem usa {{link_grupo}} e não há destino ativo: voltou a `pending`
--   skipped             o contato não pode mais receber (bloqueado, recusou marketing…)
--   already_processing  outro worker já passou por aqui com este mesmo token
--   lost                a reserva não é mais sua (varrida, cancelada, outro token)
-- Ordem de locks: campanha (share) -> contato. É a mesma de fn_campaign_transition.
create or replace function public.fn_campaign_begin_send(
  p_org uuid, p_campaign_contact uuid, p_claim_token uuid, p_send_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  v_campaign_id uuid; c public.campaigns%rowtype; cc public.campaign_contacts%rowtype;
  k public.contacts%rowtype; v public.campaign_message_versions%rowtype;
  d public.campaign_destinations%rowtype; v_skip text;
begin
  select campaign_id into v_campaign_id from public.campaign_contacts
   where id = p_campaign_contact and organization_id = p_org;
  if not found then return jsonb_build_object('decision', 'lost'); end if;

  select * into c from public.campaigns where id = v_campaign_id for share;
  select * into cc from public.campaign_contacts where id = p_campaign_contact for update;

  if cc.status = 'processing' and cc.claim_token = p_claim_token then
    return jsonb_build_object('decision', 'already_processing');
  end if;
  if cc.status <> 'queued' or cc.claim_token is distinct from p_claim_token then
    return jsonb_build_object('decision', 'lost');
  end if;

  if c.status <> 'running' then
    update public.campaign_contacts
       set status = 'pending', claim_token = null, lease_expires_at = null,
           channel_session_id = null, updated_at = now()
     where id = cc.id;
    return jsonb_build_object('decision', 'released', 'campaign_status', c.status);
  end if;

  if not exists (select 1 from public.campaign_channels ch
                  where ch.campaign_id = c.id and ch.channel_session_id = cc.channel_session_id and ch.enabled)
     or not exists (select 1 from public.channel_sessions s
                     where s.id = cc.channel_session_id and s.status = 'WORKING' and s.archived_at is null) then
    update public.campaign_contacts
       set status = 'pending', claim_token = null, lease_expires_at = null,
           channel_session_id = null, updated_at = now()
     where id = cc.id;
    return jsonb_build_object('decision', 'channel_unavailable');
  end if;

  select * into k from public.contacts where id = cc.contact_id;
  v_skip := case
    when k.is_anonymized then 'anonymized'
    when k.is_merged_into is not null then 'merged'
    when k.is_blocked then 'blocked'
    when coalesce(k.consent -> 'marketing' ->> 'declined_at', '') <> '' then 'declined_marketing'
    when nullif(btrim(coalesce(k.phone_number, '')), '') is null
         and nullif(btrim(coalesce(k.wa_lid, '')), '') is null then 'no_phone'
    else null end;
  if v_skip is not null then
    update public.campaign_contacts
       set status = 'skipped', skip_reason = v_skip, claim_token = null, lease_expires_at = null,
           updated_at = now()
     where id = cc.id;
    perform public.fn_campaign_log(p_org, c.id, 'skipped', null, cc.id, null, null, cc.channel_session_id,
      jsonb_build_object('reason', v_skip), 'skipped:' || cc.id);
    return jsonb_build_object('decision', 'skipped', 'reason', v_skip);
  end if;

  select * into v from public.campaign_message_versions where id = c.active_version_id;
  if not found then raise exception 'campaign_no_message' using errcode = 'P0001'; end if;
  if c.active_destination_id is not null then
    select * into d from public.campaign_destinations where id = c.active_destination_id;
  end if;
  if c.active_destination_id is null and v.body ~ '\{\{\s*link_grupo\s*\}\}' then
    update public.campaign_contacts
       set status = 'pending', claim_token = null, lease_expires_at = null,
           channel_session_id = null, updated_at = now()
     where id = cc.id;
    return jsonb_build_object('decision', 'no_destination');
  end if;

  update public.campaign_contacts
     set status = 'processing', message_version_id = v.id, destination_id = c.active_destination_id,
         attempts = attempts + 1,
         lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_send_lease_seconds, 120), 30)),
         updated_at = now()
   where id = cc.id;

  return jsonb_build_object(
    'decision', 'send',
    'campaign_contact_id', cc.id, 'campaign_id', c.id, 'contact_id', cc.contact_id,
    'channel_session_id', cc.channel_session_id,
    'message_version_id', v.id, 'version_no', v.version_no, 'body', v.body,
    'destination_id', d.id, 'destination_url', d.invite_url,
    'tracking_enabled', c.tracking_enabled, 'tracking_token', cc.tracking_token,
    'variables', cc.variables, 'attempts', cc.attempts + 1);
end $f$;

-- D12. Envio concluído. Idempotente. Aceita também `uncertain` -> sent: a mensagem
-- existe (o worker que "morreu" acabou o trabalho depois de a lease vencer).
create or replace function public.fn_campaign_mark_sent(
  p_org uuid, p_campaign_contact uuid, p_claim_token uuid,
  p_message_id uuid default null, p_external_id text default null
) returns text language plpgsql security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype;
begin
  select * into cc from public.campaign_contacts
   where id = p_campaign_contact and organization_id = p_org for update;
  if not found or cc.claim_token is distinct from p_claim_token then return 'lost'; end if;
  if cc.status = 'sent' then return 'already'; end if;
  if cc.status not in ('processing','uncertain') then return 'lost'; end if;

  update public.campaign_contacts
     set status = 'sent', sent_at = now(), lease_expires_at = null,
         message_id = coalesce(p_message_id, message_id),
         last_error_code = null, last_error = null, updated_at = now()
   where id = cc.id;
  perform public.fn_campaign_log(p_org, cc.campaign_id, 'sent', null, cc.id,
    cc.message_version_id, cc.destination_id, cc.channel_session_id,
    jsonb_build_object('external_id', p_external_id, 'attempts', cc.attempts), 'sent:' || cc.id);
  return 'ok';
end $f$;

-- D13. Envio que falhou COM CERTEZA de que não saiu (ex.: número desconectado antes
-- do envio). `p_retryable` reagenda com backoff; senão vira `failed`. Falha ambígua
-- (timeout depois de o WAHA aceitar) NÃO passa por aqui: é fn_campaign_mark_uncertain.
create or replace function public.fn_campaign_mark_failed(
  p_org uuid, p_campaign_contact uuid, p_claim_token uuid, p_error_code text, p_error text,
  p_retryable boolean default false, p_max_attempts integer default 3
) returns text language plpgsql security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype; v_backoff integer;
begin
  select * into cc from public.campaign_contacts
   where id = p_campaign_contact and organization_id = p_org for update;
  if not found or cc.claim_token is distinct from p_claim_token or cc.status <> 'processing' then
    return 'lost';
  end if;
  if coalesce(p_retryable, false) and cc.attempts < greatest(coalesce(p_max_attempts, 3), 1) then
    v_backoff := least(3600, 60 * (2 ^ greatest(cc.attempts - 1, 0))::integer);
    update public.campaign_contacts
       set status = 'pending', claim_token = null, lease_expires_at = null, channel_session_id = null,
           next_attempt_at = now() + make_interval(secs => v_backoff),
           last_error_code = left(p_error_code, 64), last_error = left(p_error, 500), updated_at = now()
     where id = cc.id;
    return 'retry';
  end if;
  update public.campaign_contacts
     set status = 'failed', claim_token = null, lease_expires_at = null,
         last_error_code = left(p_error_code, 64), last_error = left(p_error, 500), updated_at = now()
   where id = cc.id;
  perform public.fn_campaign_log(p_org, cc.campaign_id, 'send_failed', null, cc.id,
    cc.message_version_id, cc.destination_id, cc.channel_session_id,
    jsonb_build_object('code', left(p_error_code, 64), 'attempts', cc.attempts), 'send_failed:' || cc.id);
  return 'failed';
end $f$;

-- D14. Não dá para saber se saiu. Fica `uncertain` para uma pessoa decidir.
create or replace function public.fn_campaign_mark_uncertain(
  p_org uuid, p_campaign_contact uuid, p_claim_token uuid, p_error_code text default null, p_error text default null
) returns text language plpgsql security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype;
begin
  select * into cc from public.campaign_contacts
   where id = p_campaign_contact and organization_id = p_org for update;
  if not found or cc.claim_token is distinct from p_claim_token or cc.status <> 'processing' then
    return 'lost';
  end if;
  update public.campaign_contacts
     set status = 'uncertain', lease_expires_at = null,
         last_error_code = left(p_error_code, 64), last_error = left(p_error, 500), updated_at = now()
   where id = cc.id;
  perform public.fn_campaign_log(p_org, cc.campaign_id, 'uncertain', null, cc.id,
    cc.message_version_id, cc.destination_id, cc.channel_session_id,
    jsonb_build_object('code', left(p_error_code, 64)), 'uncertain:' || cc.id);
  return 'ok';
end $f$;

-- D15. O varredor de leases vencidas (worker que morreu). Reservado e não iniciado
-- -> volta para a fila; em envio -> `uncertain` (nunca reenvia sozinho). Roda em todas as
-- organizações, mesmo com a campanha pausada.
create or replace function public.fn_campaign_sweep_leases(p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_released integer := 0; v_uncertain integer := 0; r record;
begin
  with picked as (
    select id from public.campaign_contacts
     where status = 'queued' and lease_expires_at < now()
     order by lease_expires_at limit greatest(coalesce(p_limit, 500), 1)
     for update skip locked
  ), upd as (
    update public.campaign_contacts cc
       set status = 'pending', claim_token = null, lease_expires_at = null,
           channel_session_id = null, updated_at = now()
      from picked where cc.id = picked.id
    returning cc.id)
  select count(*) into v_released from upd;

  for r in
    select id, organization_id, campaign_id, message_version_id, destination_id, channel_session_id
      from public.campaign_contacts
     where status = 'processing' and lease_expires_at < now()
     order by lease_expires_at limit greatest(coalesce(p_limit, 500), 1)
     for update skip locked
  loop
    update public.campaign_contacts
       set status = 'uncertain', lease_expires_at = null,
           last_error_code = 'lease_expired', updated_at = now()
     where id = r.id;
    perform public.fn_campaign_log(r.organization_id, r.campaign_id, 'uncertain', null, r.id,
      r.message_version_id, r.destination_id, r.channel_session_id,
      jsonb_build_object('code', 'lease_expired'), 'uncertain:' || r.id);
    v_uncertain := v_uncertain + 1;
  end loop;

  return jsonb_build_object('released', v_released, 'uncertain', v_uncertain);
end $f$;

-- D16. Encerra sozinha a campanha que não tem mais nada por processar.
create or replace function public.fn_campaign_complete_if_done(p_org uuid, p_campaign uuid)
returns boolean language plpgsql security definer set search_path = public as $f$
declare v_status text;
begin
  select status into v_status from public.campaigns
   where id = p_campaign and organization_id = p_org for no key update;
  if v_status is distinct from 'running' then return false; end if;
  if exists (select 1 from public.campaign_contacts
              where campaign_id = p_campaign and status in ('pending','queued','processing')) then
    return false;
  end if;
  update public.campaign_destinations
     set status = 'closed', closed_at = now(), close_reason = 'campaign_ended'
   where campaign_id = p_campaign and status = 'active';
  update public.campaigns
     set status = 'completed', status_reason = null, finished_at = now(), revision = revision + 1
   where id = p_campaign;
  perform public.fn_campaign_log(p_org, p_campaign, 'completed', null, null, null, null, null,
    jsonb_build_object('from', 'running', 'to', 'completed', 'reason', 'all_processed'));
  return true;
end $f$;

-- D17. Contagens da campanha, direto da fonte (nunca de contador agregado).
create or replace function public.fn_campaign_counts(p_org uuid, p_campaign uuid)
returns jsonb language sql stable security definer set search_path = public as $f$
  select jsonb_build_object(
    'total', count(*),
    'pending', count(*) filter (where status = 'pending'),
    'queued', count(*) filter (where status = 'queued'),
    'processing', count(*) filter (where status = 'processing'),
    'sent', count(*) filter (where status = 'sent'),
    'failed', count(*) filter (where status = 'failed'),
    'uncertain', count(*) filter (where status = 'uncertain'),
    'skipped', count(*) filter (where status = 'skipped'),
    'cancelled', count(*) filter (where status = 'cancelled'),
    'clicked', count(clicked_at),
    'replied', count(replied_at),
    'joined', count(joined_at),
    'left', count(left_at))
  from public.campaign_contacts
  where campaign_id = p_campaign and organization_id = p_org
$f$;

-- ═══ E. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
-- Função nova em `public` nasce exposta por DUAS origens (default ACL do Supabase a
-- anon e o grant a PUBLIC do Postgres); as duas saem, e só o service_role fica.
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in (
         'fn_campaign_log','fn_campaign_create','fn_campaign_update_settings','fn_campaign_set_channels',
         'fn_campaign_create_version','fn_campaign_switch_destination','fn_campaign_add_destination',
         'fn_campaign_assert_startable','fn_campaign_transition','fn_campaign_claim_batch',
         'fn_campaign_begin_send','fn_campaign_mark_sent','fn_campaign_mark_failed',
         'fn_campaign_mark_uncertain','fn_campaign_sweep_leases','fn_campaign_complete_if_done',
         'fn_campaign_counts','fn_redigir_disparos_do_contato_anonimizado','fn_campaign_version_imutavel')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;

comment on table public.campaigns is 'Campanha de WhatsApp (Central de Disparos). status é a máquina de estados; ponteiros active_* dizem o que vale para o PRÓXIMO envio.';
comment on table public.campaign_contacts is 'Um contato dentro de uma campanha, com estado próprio. status = entrega; clicked_at/replied_at/joined_at/left_at = engajamento (projeção de campaign_events).';
comment on table public.campaign_events is 'Linha do tempo append-only da campanha e de cada contato. Nunca apagada, nem pelo service_role.';
comment on table public.campaign_message_versions is 'Versões imutáveis da mensagem. Enviar com a V2 não reescreve o que a V1 já enviou.';
comment on table public.campaign_destinations is 'Grupos/links de destino da campanha, na ordem em que foram usados; no máximo um ativo.';

-- As tabelas novas entram nas travas do modo somente leitura do suporte.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
