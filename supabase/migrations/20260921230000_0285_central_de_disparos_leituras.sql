-- Central de Disparos — LEITURAS (0285): o que a tela precisa ler sem varrer o mundo.
--
-- Nenhuma tabela nova. Três funções de leitura e um índice:
--
--  A. `fn_campaign_metrics`: o funil e as quebras POR VERSÃO, POR DESTINO e POR NÚMERO de uma
--     campanha, numa passada só sobre `campaign_contacts` (índices por campanha). É o que
--     responde "a V2 rendeu mais que a V1?", "quantos o BLACK #04 recebeu?" e "qual número
--     está falhando?" — dados, sem ranking nem recomendação.
--
--  B. `fn_campaign_dashboard`: os sete números do topo da Central, para a organização inteira.
--     Cliques, entradas e respostas são as das campanhas ATIVAS (rodando ou pausadas);
--     "enviados hoje" é de todas, desde o instante que o chamador informa (a meia-noite local
--     da organização — quem conhece o fuso é o servidor, não o banco).
--
--  C. `fn_campaign_actor_names`: quem fez cada mudança ("Bruno alterou a mensagem V2 → V3"),
--     só entre os membros da organização.
--
-- Contadores de `campaign_contacts` vêm SEMPRE da fonte (as linhas), nunca de um contador
-- agregado que possa divergir. O custo é uma agregação por campanha; a tela não pergunta mais
-- que uma vez a cada poucos segundos e só com a campanha aberta.

create index if not exists idx_campaign_contacts_org_sent
  on public.campaign_contacts (organization_id, sent_at) where status = 'sent';

-- ═══ A. MÉTRICAS DA CAMPANHA ══════════════════════════════════════════════════
create or replace function public.fn_campaign_metrics(p_org uuid, p_campaign uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $f$
declare v jsonb;
begin
  if not exists (select 1 from public.campaigns where id = p_campaign and organization_id = p_org) then
    raise exception 'campaign_not_found' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'by_version', coalesce((
      select jsonb_agg(jsonb_build_object(
               'version_no', v.version_no, 'version_id', v.id,
               'sent', coalesce(g.sent, 0), 'clicked', coalesce(g.clicked, 0),
               'replied', coalesce(g.replied, 0), 'failed', coalesce(g.failed, 0))
             order by v.version_no)
        from public.campaign_message_versions v
        left join (
          select message_version_id,
                 count(*) filter (where status = 'sent') as sent,
                 count(*) filter (where status = 'sent' and clicked_at is not null) as clicked,
                 count(*) filter (where status = 'sent' and replied_at is not null) as replied,
                 count(*) filter (where status = 'failed') as failed
            from public.campaign_contacts
           where campaign_id = p_campaign and message_version_id is not null
           group by message_version_id) g on g.message_version_id = v.id
       where v.campaign_id = p_campaign), '[]'::jsonb),
    'by_destination', coalesce((
      select jsonb_agg(jsonb_build_object(
               'destination_id', d.id, 'sequence_no', d.sequence_no, 'name', d.name,
               'status', d.status, 'capacity', d.capacity,
               'opened_at', d.opened_at, 'closed_at', d.closed_at, 'close_reason', d.close_reason,
               'directed', coalesce(g.directed, 0), 'clicked', coalesce(g.clicked, 0),
               'joined', coalesce(g.joined, 0), 'left', coalesce(g.left_, 0),
               'clicks_raw', coalesce(k.raw, 0))
             order by d.sequence_no)
        from public.campaign_destinations d
        left join (
          select destination_id,
                 count(*) filter (where status = 'sent') as directed,
                 count(*) filter (where status = 'sent' and clicked_at is not null) as clicked,
                 count(*) filter (where joined_at is not null) as joined,
                 count(*) filter (where left_at is not null) as left_
            from public.campaign_contacts
           where campaign_id = p_campaign and destination_id is not null
           group by destination_id) g on g.destination_id = d.id
        left join (
          select destination_id, count(*) as raw
            from public.campaign_clicks
           where campaign_id = p_campaign and agent_class = 'browser' and destination_id is not null
           group by destination_id) k on k.destination_id = d.id
       where d.campaign_id = p_campaign), '[]'::jsonb),
    'by_channel', coalesce((
      select jsonb_agg(jsonb_build_object(
               'channel_session_id', g.channel_session_id, 'sent', g.sent, 'failed', g.failed,
               'uncertain', g.uncertain, 'last_sent_at', g.last_sent_at)
             order by g.channel_session_id)
        from (
          select channel_session_id,
                 count(*) filter (where status = 'sent') as sent,
                 count(*) filter (where status = 'failed') as failed,
                 count(*) filter (where status = 'uncertain') as uncertain,
                 max(sent_at) as last_sent_at
            from public.campaign_contacts
           where campaign_id = p_campaign and channel_session_id is not null
           group by channel_session_id) g), '[]'::jsonb))
    into v;
  return v;
end $f$;

-- ═══ B. OS SETE NÚMEROS DO TOPO ═══════════════════════════════════════════════
create or replace function public.fn_campaign_dashboard(p_org uuid, p_since timestamptz)
returns jsonb language sql stable security definer set search_path = public as $f$
  select jsonb_build_object(
    'running', (select count(*) from public.campaigns where organization_id = p_org and status = 'running'),
    'paused', (select count(*) from public.campaigns where organization_id = p_org and status = 'paused'),
    'sent_today', (select count(*) from public.campaign_contacts
                    where organization_id = p_org and status = 'sent' and sent_at >= p_since),
    'active', coalesce((
      select jsonb_build_object(
               'pending', count(*) filter (where cc.status in ('pending','queued','processing')),
               'sent', count(*) filter (where cc.status = 'sent'),
               'failed', count(*) filter (where cc.status in ('failed','uncertain')),
               'clicked', count(cc.clicked_at),
               'replied', count(cc.replied_at),
               'joined', count(cc.joined_at),
               'left', count(cc.left_at))
        from public.campaign_contacts cc
        join public.campaigns c on c.id = cc.campaign_id
       where cc.organization_id = p_org and c.status in ('running','paused')), '{}'::jsonb))
$f$;

-- ═══ C. NOMES DE QUEM FEZ CADA MUDANÇA ════════════════════════════════════════
create or replace function public.fn_campaign_actor_names(p_org uuid, p_ids uuid[])
returns table (id uuid, name text) language sql stable security definer set search_path = public as $f$
  select u.id,
         coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                  nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                  split_part(u.email, '@', 1))
    from auth.users u
    join public.user_organizations m on m.user_id = u.id and m.organization_id = p_org
   where u.id = any (coalesce(p_ids, '{}'::uuid[]))
$f$;

-- ═══ D. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fn_campaign_metrics', 'fn_campaign_dashboard', 'fn_campaign_actor_names')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;
