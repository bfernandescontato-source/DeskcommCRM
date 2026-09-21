-- Central de Disparos — RASTREIO DE CLIQUES (0284).
--
-- A mensagem leva `<app>/g/<token>` em vez do convite cru. O token é 80 bits aleatórios,
-- um por contato (`campaign_contacts.tracking_token`, 0280): não é sequencial, não carrega
-- id nenhum e só existe para quem RECEBEU a mensagem. A rota pública resolve o token,
-- redireciona NA HORA e registra o clique DEPOIS da resposta — o visitante nunca espera
-- por escrita em banco.
--
-- ─── O QUE É CLIQUE ────────────────────────────────────────────────────────────
-- Quem cola um link no WhatsApp recebe, do próprio WhatsApp, uma visita de PRÉ-VISUALIZAÇÃO
-- (e crawlers de outros serviços). Contar isso como clique inflaria o CTR e mentiria sobre
-- quem se interessou. Por isso cada clique tem uma `agent_class`: só `browser` marca
-- `clicked_at` e gera o evento `clicked`; `preview` e `bot` ficam gravados (para o operador
-- ver a diferença) mas NÃO contam como pessoa.
--
-- ─── PARA ONDE O CLIQUE VAI ────────────────────────────────────────────────────
-- Para o destino que o contato recebeu (o carimbado no envio). Exceção deliberada: se esse
-- grupo foi encerrado como LOTADO (`close_reason = 'full'`) e a campanha tem outro destino
-- ativo, o clique vai para o ativo — quem clica dias depois num link antigo cairia num grupo
-- cheio, que é o que o operador quis evitar ao trocar. A contagem de "direcionados" continua
-- por destino de ENVIO; o clique guarda para onde de fato foi (`destination_id`) e de onde
-- veio (`from_destination_id`). Encerrar o grupo à mão NÃO redireciona: aí a decisão foi outra.
--
-- ─── SEGURANÇA ─────────────────────────────────────────────────────────────────
-- Sem endereço de IP e sem user-agent gravados (só a classe). Token que não existe, que
-- nunca foi enviado ou que não tem o formato devolve NULL: a rota responde 404 e nunca
-- redireciona para lugar nenhum além de um destino cadastrado por uma pessoa autorizada.
-- Um clique repetido do mesmo contato em 10 segundos não vira linha nova.

-- ═══ A. TABELA ════════════════════════════════════════════════════════════════

create table if not exists public.campaign_clicks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  campaign_contact_id uuid not null references public.campaign_contacts(id) on delete cascade,
  message_version_id uuid,
  -- Para onde o clique FOI levado, e (se diferente) o destino do envio de onde saiu.
  destination_id uuid,
  from_destination_id uuid,
  agent_class text not null check (agent_class in ('browser','preview','bot')),
  occurred_at timestamptz not null default now(),
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade,
  foreign key (message_version_id, campaign_id)
    references public.campaign_message_versions (id, campaign_id),
  foreign key (destination_id, campaign_id)
    references public.campaign_destinations (id, campaign_id),
  foreign key (from_destination_id, campaign_id)
    references public.campaign_destinations (id, campaign_id)
);

create index if not exists idx_campaign_clicks_campaign
  on public.campaign_clicks (campaign_id, occurred_at desc);
create index if not exists idx_campaign_clicks_contact
  on public.campaign_clicks (campaign_contact_id, occurred_at desc);
create index if not exists idx_campaign_clicks_destination
  on public.campaign_clicks (campaign_id, destination_id) where destination_id is not null;

alter table public.campaign_clicks enable row level security;
drop policy if exists tenant_isolation_campaign_clicks_all on public.campaign_clicks;
create policy tenant_isolation_campaign_clicks_all on public.campaign_clicks for all
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
revoke all on public.campaign_clicks from anon, authenticated, public;
grant select on public.campaign_clicks to authenticated;
-- Append-only, como a trilha: o histórico de cliques não se reescreve.
revoke update, delete, truncate on public.campaign_clicks from anon, authenticated, service_role;

-- ═══ B. RESOLVER O CLIQUE (síncrono, tem de ser rápido) ═══════════════════════

create or replace function public.fn_campaign_click_target(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype; c public.campaigns%rowtype;
        d public.campaign_destinations%rowtype; a public.campaign_destinations%rowtype;
begin
  -- Formato antes de qualquer consulta: lixo e tentativa de injeção nem chegam ao índice.
  if p_token is null or p_token !~ '^[0-9a-f]{20}$' then return null; end if;
  select * into cc from public.campaign_contacts where tracking_token = p_token;
  -- Sem destino carimbado = a mensagem nunca saiu: o token não foi entregue a ninguém.
  if not found or cc.destination_id is null then return null; end if;
  select * into d from public.campaign_destinations where id = cc.destination_id;
  select * into c from public.campaigns where id = cc.campaign_id;

  if d.status = 'closed' and d.close_reason = 'full'
     and c.active_destination_id is not null and c.active_destination_id <> d.id
     and c.status <> 'cancelled' then
    select * into a from public.campaign_destinations where id = c.active_destination_id;
    return jsonb_build_object(
      'campaign_contact_id', cc.id, 'campaign_id', cc.campaign_id, 'organization_id', cc.organization_id,
      'message_version_id', cc.message_version_id, 'destination_id', a.id, 'url', a.invite_url,
      'from_destination_id', d.id);
  end if;
  return jsonb_build_object(
    'campaign_contact_id', cc.id, 'campaign_id', cc.campaign_id, 'organization_id', cc.organization_id,
    'message_version_id', cc.message_version_id, 'destination_id', d.id, 'url', d.invite_url,
    'from_destination_id', null);
end $f$;

-- ═══ C. REGISTRAR O CLIQUE (depois da resposta) ═══════════════════════════════
-- Só `browser` conta como pessoa: marca `clicked_at` e gera o evento uma única vez.
create or replace function public.fn_campaign_record_click(
  p_token text, p_destination uuid, p_from_destination uuid, p_agent_class text
) returns text language plpgsql security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype;
begin
  if p_agent_class not in ('browser','preview','bot') then
    raise exception 'campaign_invalid_action' using errcode = 'P0001';
  end if;
  select * into cc from public.campaign_contacts where tracking_token = p_token;
  if not found then return 'unknown'; end if;
  -- O mesmo contato, da mesma classe, dentro de 10s: um clique só (duplo toque, reenvio de rede).
  if exists (select 1 from public.campaign_clicks
              where campaign_contact_id = cc.id and agent_class = p_agent_class
                and occurred_at > now() - interval '10 seconds') then
    return 'duplicate';
  end if;
  insert into public.campaign_clicks
    (organization_id, campaign_id, campaign_contact_id, message_version_id,
     destination_id, from_destination_id, agent_class)
  values (cc.organization_id, cc.campaign_id, cc.id, cc.message_version_id,
          p_destination, p_from_destination, p_agent_class);
  if p_agent_class = 'browser' then
    update public.campaign_contacts set clicked_at = now(), updated_at = now()
     where id = cc.id and clicked_at is null;
    if found then
      perform public.fn_campaign_log(cc.organization_id, cc.campaign_id, 'clicked', null, cc.id,
        cc.message_version_id, p_destination, cc.channel_session_id,
        jsonb_build_object('from_destination_id', p_from_destination), 'clicked:' || cc.id);
    end if;
  end if;
  return 'ok';
end $f$;

-- ═══ D. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fn_campaign_click_target', 'fn_campaign_record_click')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;

comment on table public.campaign_clicks is 'Cliques no link rastreável (/g/<token>). Só agent_class = browser conta como pessoa; preview/bot ficam gravados mas não contam. Append-only.';

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
