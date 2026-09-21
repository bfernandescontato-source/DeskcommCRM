-- Central de Disparos — ENTRADAS E SAÍDAS DE GRUPO (0286).
--
-- O funil termina em "entrou no grupo" e "saiu do grupo". Este é o único lugar que escreve
-- essas duas coisas, e só com EVIDÊNCIA: o aviso que o WhatsApp mandou de que alguém entrou ou
-- saiu de um grupo que é destino de uma campanha.
--
-- ─── O QUE NUNCA SE FAZ ────────────────────────────────────────────────────────
-- * Clique NÃO prova entrada. `fn_campaign_record_click` nunca toca `joined_at`; um contato
--   que clicou e nunca apareceu em evento de grupo continua "clicou", não "entrou".
-- * Quem não é reconhecido NÃO é inventado. Um evento pode não ser atribuível a nenhum
--   contato (a pessoa entrou por outro caminho, ou o WhatsApp só informou um identificador
--   que não conhecemos): ele é gravado do mesmo jeito, como `unattributed`, e conta como
--   membro do grupo — só não vira "esta pessoa da campanha entrou".
-- * Grupo que não é destino de nenhuma campanha NÃO é gravado: não há por que guardar o
--   telefone de quem entra em grupos que nada têm a ver com a Central.
--
-- ─── COMO SE ATRIBUI ───────────────────────────────────────────────────────────
-- Por telefone (todas as variantes do número) ou por `contacts.wa_lid` (o identificador que
-- o próprio WhatsApp já nos deu para aquele contato). Só entre contatos JÁ ENVIADOS da
-- campanha dona do destino. Nada de casar por nome, por horário ou por proximidade.
--
-- ─── PRIVACIDADE ───────────────────────────────────────────────────────────────
-- O telefone/identificador cru do participante NÃO é gravado: só `md5` dele (para contar
-- pessoas distintas e dedupar). Quando há atribuição, a pessoa é o contato que o CRM já
-- conhecia (`campaign_contact_id`).
--
-- ─── ONDE ENTRA NA CONTA ───────────────────────────────────────────────────────
-- `campaign_contacts.joined_at` / `left_at` (quem foi identificado) alimentam o funil e o
-- estado do contato. `fn_campaign_metrics` passa a devolver, por destino, também
-- `members` (pessoas cuja ÚLTIMA notícia foi "entrou"), `joined_total` e `members_left` —
-- a ocupação MEDIDA do grupo (desde que o monitoramento começou), com ou sem atribuição.

-- ═══ A. TABELA ════════════════════════════════════════════════════════════════

create table if not exists public.campaign_group_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  campaign_id uuid not null,
  destination_id uuid not null,
  campaign_contact_id uuid references public.campaign_contacts(id) on delete set null,
  -- O número que OBSERVOU o evento (pode haver mais de um no mesmo grupo: o evento é um só).
  channel_session_id uuid,
  group_chat_id text not null check (char_length(group_chat_id) between 3 and 128),
  kind text not null check (kind in ('join','leave')),
  participant_key text not null check (char_length(participant_key) = 32),
  attribution text not null check (attribution in ('phone_match','lid_match','unattributed')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  idempotency_key text not null,
  foreign key (campaign_id, organization_id)
    references public.campaigns (id, organization_id) on delete cascade,
  foreign key (destination_id, campaign_id)
    references public.campaign_destinations (id, campaign_id) on delete cascade,
  constraint uniq_campaign_group_events_idem unique (organization_id, idempotency_key)
);

create index if not exists idx_campaign_group_events_dest
  on public.campaign_group_events (campaign_id, destination_id, participant_key, occurred_at desc, id desc);
create index if not exists idx_campaign_group_events_contact
  on public.campaign_group_events (campaign_contact_id) where campaign_contact_id is not null;
-- Achar "de quais campanhas é este grupo" a cada aviso do WhatsApp tem de ser barato.
create index if not exists idx_campaign_destinations_group_chat
  on public.campaign_destinations (organization_id, group_chat_id) where group_chat_id is not null;
-- A aba Atividade lista só o que aconteceu com a CAMPANHA (sem os envios de cada contato).
create index if not exists idx_campaign_events_campaign_only
  on public.campaign_events (campaign_id, occurred_at desc, id desc) where campaign_contact_id is null;

alter table public.campaign_group_events enable row level security;
drop policy if exists tenant_isolation_campaign_group_events_all on public.campaign_group_events;
create policy tenant_isolation_campaign_group_events_all on public.campaign_group_events for all
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());
revoke all on public.campaign_group_events from anon, authenticated, public;
grant select on public.campaign_group_events to authenticated;
-- Append-only, como a trilha e os cliques: o que o WhatsApp avisou não se reescreve.
revoke update, delete, truncate on public.campaign_group_events from anon, authenticated, service_role;

-- ═══ B. REGISTRAR UM AVISO DE ENTRADA/SAÍDA ═══════════════════════════════════
-- Chamada uma vez por participante do aviso. Idempotente: o mesmo aviso (mesmo grupo, mesma
-- pessoa, mesmo tipo, mesmo segundo) visto por dois números, ou entregue duas vezes, é UM evento.
create or replace function public.fn_campaign_record_group_event(
  p_org uuid, p_session uuid, p_group_chat_id text, p_kind text,
  p_participant_ref text, p_phone_variants text[], p_lid text, p_occurred_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare
  d record; v_key text; v_cc uuid; v_attr text; v_id uuid;
  v_matched integer := 0; v_recorded integer := 0; v_attributed integer := 0;
begin
  if p_kind not in ('join','leave') or p_group_chat_id is null or p_occurred_at is null
     or p_participant_ref is null or btrim(p_participant_ref) = '' then
    raise exception 'campaign_group_event_invalid' using errcode = 'P0001';
  end if;
  v_key := md5(lower(btrim(p_participant_ref)));

  for d in
    select id, campaign_id from public.campaign_destinations
     where organization_id = p_org and group_chat_id = p_group_chat_id
     order by created_at, id
  loop
    v_matched := v_matched + 1;
    v_cc := null; v_attr := 'unattributed'; v_id := null;

    -- Só contatos JÁ ENVIADOS da campanha dona deste destino. Telefone primeiro, depois o LID.
    if p_phone_variants is not null and cardinality(p_phone_variants) > 0 then
      select cc.id into v_cc
        from public.campaign_contacts cc join public.contacts ct on ct.id = cc.contact_id
       where cc.campaign_id = d.campaign_id and cc.status = 'sent'
         and ct.phone_number = any (p_phone_variants)
       order by cc.seq limit 1;
      if v_cc is not null then v_attr := 'phone_match'; end if;
    end if;
    if v_cc is null and p_lid is not null and btrim(p_lid) <> '' then
      select cc.id into v_cc
        from public.campaign_contacts cc join public.contacts ct on ct.id = cc.contact_id
       where cc.campaign_id = d.campaign_id and cc.status = 'sent' and ct.wa_lid = btrim(p_lid)
       order by cc.seq limit 1;
      if v_cc is not null then v_attr := 'lid_match'; end if;
    end if;

    insert into public.campaign_group_events
      (organization_id, campaign_id, destination_id, campaign_contact_id, channel_session_id,
       group_chat_id, kind, participant_key, attribution, occurred_at, idempotency_key)
    values
      (p_org, d.campaign_id, d.id, v_cc, p_session, p_group_chat_id, p_kind, v_key, v_attr, p_occurred_at,
       format('%s|%s|%s|%s|%s', p_group_chat_id, v_key, p_kind, extract(epoch from p_occurred_at)::bigint, d.id))
    on conflict (organization_id, idempotency_key) do nothing
    returning id into v_id;
    if v_id is null then continue; end if;   -- já registrado: nada muda pela segunda vez

    v_recorded := v_recorded + 1;
    if v_cc is not null then
      v_attributed := v_attributed + 1;
      if p_kind = 'join' then
        -- A primeira entrada fica; uma entrada DEPOIS de uma saída volta a contar como "está no grupo".
        update public.campaign_contacts
           set joined_at = least(coalesce(joined_at, p_occurred_at), p_occurred_at),
               left_at = case when left_at is not null and left_at <= p_occurred_at then null else left_at end,
               updated_at = now()
         where id = v_cc;
      else
        -- Uma saída mais ANTIGA que a entrada registrada (avisos fora de ordem) não desfaz a entrada.
        update public.campaign_contacts
           set left_at = case when (joined_at is null or p_occurred_at >= joined_at)
                                and (left_at is null or left_at < p_occurred_at)
                              then p_occurred_at else left_at end,
               updated_at = now()
         where id = v_cc;
      end if;
      perform public.fn_campaign_log(p_org, d.campaign_id,
        case when p_kind = 'join' then 'joined' else 'left' end, null, v_cc, null, d.id, p_session,
        jsonb_build_object('attribution', v_attr, 'source', 'group_event'), 'grp:' || v_id::text);
    end if;
  end loop;

  return jsonb_build_object('matched_destinations', v_matched, 'recorded', v_recorded, 'attributed', v_attributed);
end $f$;

-- ═══ C. MÉTRICAS: A OCUPAÇÃO MEDIDA ═══════════════════════════════════════════
-- Mesma função da 0285, com três campos a mais por destino. Nada do que já existia muda.
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
               'clicks_raw', coalesce(k.raw, 0),
               'members', coalesce(gm.members, 0),
               'members_left', coalesce(gm.left_now, 0),
               'joined_total', coalesce(ge.joined_total, 0))
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
        left join (
          select destination_id, count(distinct participant_key) as joined_total
            from public.campaign_group_events
           where campaign_id = p_campaign and kind = 'join'
           group by destination_id) ge on ge.destination_id = d.id
        left join (
          -- A ÚLTIMA notícia de cada pessoa decide se ela está no grupo agora.
          select destination_id,
                 count(*) filter (where kind = 'join') as members,
                 count(*) filter (where kind = 'leave') as left_now
            from (select distinct on (destination_id, participant_key) destination_id, participant_key, kind
                    from public.campaign_group_events
                   where campaign_id = p_campaign
                   order by destination_id, participant_key, occurred_at desc, id desc) u
           group by destination_id) gm on gm.destination_id = d.id
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

-- ═══ D. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fn_campaign_record_group_event', 'fn_campaign_metrics')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;

comment on table public.campaign_group_events is 'Avisos do WhatsApp de que alguém entrou/saiu de um grupo que é destino de campanha. Só evidência: nunca inferido de clique. Sem telefone cru (md5 do participante). Append-only.';
