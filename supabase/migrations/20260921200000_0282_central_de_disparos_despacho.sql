-- Central de Disparos — DESPACHO (0282): o que o envio real precisa do banco.
--
-- O despachante é um cron de 1 minuto (`campaign-dispatcher`). Ele não guarda estado
-- nenhum: a cada rodada pergunta ao banco o que há para enviar e o que o ritmo
-- permite. Esta migration dá ao banco o que faltava para isso ser seguro:
--
--  A. RITMO POR CAMPANHA. `send_interval_seconds` (intervalo FIXO entre dois envios
--     do mesmo número) e `daily_cap_per_channel` (teto da campanha por número, por
--     dia). O ritmo é limite de uso, não disfarce: não há jitter nem sorteio.
--
--  B. UM CONTATO EM VOO POR NÚMERO. `fn_campaign_claim_batch(p_exclusive => true)` não
--     reserva nada enquanto o número tem outro contato `queued`/`processing`. Duas
--     rodadas do cron sobrepostas (a primeira demorou) não mandam duas mensagens no
--     mesmo instante pelo mesmo número — a garantia é do banco, não de quem chama.
--
--  C. RESOLVER O INCERTO. Contato `uncertain` (worker morreu no meio, timeout depois de
--     o canal aceitar) nunca é reenviado sozinho; uma PESSOA olha a conversa e decide:
--     "enviado", "tentar de novo" ou "falhou". `fn_campaign_resolve_uncertain`.
--
--  D. OS ALVOS DA RODADA. `fn_campaign_dispatch_targets` devolve, numa consulta só, cada
--     par campanha-número que está rodando, com o que o ritmo precisa saber do número.
--
-- As duas funções que ganham parâmetro (`update_settings`, `claim_batch`) são recriadas:
-- a assinatura antiga é removida primeiro, senão as duas coexistem e a chamada por nome
-- do PostgREST fica ambígua.

-- ═══ A. RITMO POR CAMPANHA ════════════════════════════════════════════════════

alter table public.campaigns add column if not exists send_interval_seconds integer not null default 180
  check (send_interval_seconds between 10 and 3600);
alter table public.campaigns add column if not exists daily_cap_per_channel integer
  check (daily_cap_per_channel is null or daily_cap_per_channel between 1 and 5000);

-- "Quem está em voo neste número?" — a pergunta da reserva exclusiva, respondida por índice.
create index if not exists idx_campaign_contacts_inflight
  on public.campaign_contacts (channel_session_id) where status in ('queued','processing');
-- "Quantos esta campanha enviou hoje por este número?" — o teto por dia.
create index if not exists idx_campaign_contacts_sent_today
  on public.campaign_contacts (campaign_id, channel_session_id, sent_at) where status = 'sent';

drop function if exists public.fn_campaign_update_settings(uuid, uuid, uuid, text, boolean, text);
create or replace function public.fn_campaign_update_settings(
  p_org uuid, p_campaign uuid, p_actor uuid default null,
  p_name text default null, p_tracking_enabled boolean default null, p_channel_policy text default null,
  p_send_interval_seconds integer default null, p_daily_cap_per_channel integer default null,
  p_clear_daily_cap boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $f$
declare c public.campaigns%rowtype; v_changes jsonb := '{}'::jsonb; v_cap integer;
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
  if p_send_interval_seconds is not null and p_send_interval_seconds <> c.send_interval_seconds then
    v_changes := v_changes || jsonb_build_object('send_interval_seconds', jsonb_build_object('from', c.send_interval_seconds, 'to', p_send_interval_seconds));
  end if;
  -- `p_clear_daily_cap` existe porque NULL já significa "não mexer": sem ele não haveria como
  -- voltar ao teto do próprio número.
  v_cap := case when coalesce(p_clear_daily_cap, false) then null
                else coalesce(p_daily_cap_per_channel, c.daily_cap_per_channel) end;
  if v_cap is distinct from c.daily_cap_per_channel then
    v_changes := v_changes || jsonb_build_object('daily_cap_per_channel', jsonb_build_object('from', c.daily_cap_per_channel, 'to', v_cap));
  end if;
  if v_changes = '{}'::jsonb then
    return jsonb_build_object('changed', false);
  end if;
  update public.campaigns
     set name = coalesce(btrim(p_name), name),
         tracking_enabled = coalesce(p_tracking_enabled, tracking_enabled),
         channel_policy = coalesce(p_channel_policy, channel_policy),
         send_interval_seconds = coalesce(p_send_interval_seconds, send_interval_seconds),
         daily_cap_per_channel = v_cap,
         revision = revision + 1
   where id = p_campaign;
  perform public.fn_campaign_log(p_org, p_campaign, 'settings_changed', p_actor, null, null, null, null, v_changes);
  return jsonb_build_object('changed', true, 'changes', v_changes);
end $f$;

-- ═══ B. RESERVA EXCLUSIVA POR NÚMERO ══════════════════════════════════════════

drop function if exists public.fn_campaign_claim_batch(uuid, uuid, uuid, integer, integer);
create or replace function public.fn_campaign_claim_batch(
  p_org uuid, p_campaign uuid, p_channel uuid, p_limit integer default 10, p_lease_seconds integer default 90,
  p_exclusive boolean default false
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
  -- Um contato em voo por número (de QUALQUER campanha): a rodada seguinte, ou uma rodada
  -- sobreposta, espera. Lease vencida não conta — o varredor resolve essa.
  if coalesce(p_exclusive, false) and exists (
       select 1 from public.campaign_contacts x
        where x.channel_session_id = p_channel and x.status in ('queued','processing')
          and x.lease_expires_at > now()) then
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

-- ═══ C. RESOLVER O INCERTO ════════════════════════════════════════════════════
-- `sent`   a pessoa confirmou que a mensagem saiu (viu na conversa): vira enviado;
-- `retry`  não saiu: volta para o FIM DA VEZ dela na fila (mesma posição `seq`);
-- `failed` não saiu e não vale tentar: falha definitiva.
-- Repetir a mesma resolução é inofensivo (`already`).
create or replace function public.fn_campaign_resolve_uncertain(
  p_org uuid, p_campaign_contact uuid, p_resolution text, p_actor uuid default null
) returns text language plpgsql security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype; v_cstatus text;
begin
  if p_resolution not in ('sent','retry','failed') then
    raise exception 'campaign_invalid_action' using errcode = 'P0001';
  end if;
  select campaign_id into cc.campaign_id from public.campaign_contacts
   where id = p_campaign_contact and organization_id = p_org;
  if not found then raise exception 'campaign_not_found' using errcode = 'P0002'; end if;
  select status into v_cstatus from public.campaigns where id = cc.campaign_id for share;
  select * into cc from public.campaign_contacts where id = p_campaign_contact for update;

  if (p_resolution = 'sent' and cc.status = 'sent')
     or (p_resolution = 'failed' and cc.status = 'failed')
     or (p_resolution = 'retry' and cc.status = 'pending') then
    return 'already';
  end if;
  if cc.status <> 'uncertain' then return 'not_uncertain'; end if;

  if p_resolution = 'sent' then
    update public.campaign_contacts
       set status = 'sent', sent_at = coalesce(sent_at, now()), claim_token = null, lease_expires_at = null,
           last_error_code = null, last_error = null, updated_at = now()
     where id = cc.id;
    perform public.fn_campaign_log(p_org, cc.campaign_id, 'sent', p_actor, cc.id,
      cc.message_version_id, cc.destination_id, cc.channel_session_id,
      jsonb_build_object('resolved_manually', true), 'sent:' || cc.id);
  elsif p_resolution = 'failed' then
    update public.campaign_contacts
       set status = 'failed', claim_token = null, lease_expires_at = null, updated_at = now()
     where id = cc.id;
    perform public.fn_campaign_log(p_org, cc.campaign_id, 'send_failed', p_actor, cc.id,
      cc.message_version_id, cc.destination_id, cc.channel_session_id,
      jsonb_build_object('resolved_manually', true), 'send_failed:' || cc.id);
  else
    if v_cstatus in ('completed','cancelled') then
      raise exception 'campaign_closed' using errcode = 'P0001';
    end if;
    update public.campaign_contacts
       set status = 'pending', claim_token = null, lease_expires_at = null, channel_session_id = null,
           next_attempt_at = null, updated_at = now()
     where id = cc.id;
  end if;
  return 'ok';
end $f$;

-- ═══ D. OS ALVOS DA RODADA ════════════════════════════════════════════════════
-- Cada par campanha-número que está RODANDO, mais antigo primeiro (quem começou antes
-- é servido antes). Uma consulta só para o despachante inteiro.
create or replace function public.fn_campaign_dispatch_targets(p_limit integer default 500)
returns table (
  organization_id uuid, campaign_id uuid, channel_session_id uuid,
  channel_status text, channel_archived boolean, channel_provider text, daily_message_limit integer,
  channel_policy text, tracking_enabled boolean, send_interval_seconds integer,
  daily_cap_per_channel integer, started_at timestamptz
) language sql stable security definer set search_path = public as $f$
  select c.organization_id, c.id, ch.channel_session_id,
         s.status, (s.archived_at is not null), s.provider, s.daily_message_limit,
         c.channel_policy, c.tracking_enabled, c.send_interval_seconds,
         c.daily_cap_per_channel, c.started_at
    from public.campaigns c
    join public.campaign_channels ch on ch.campaign_id = c.id and ch.enabled
    join public.channel_sessions s on s.id = ch.channel_session_id
   where c.status = 'running'
   order by c.started_at nulls last, c.id, ch.created_at
   limit greatest(1, least(coalesce(p_limit, 500), 2000))
$f$;

-- ═══ E. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fn_campaign_update_settings','fn_campaign_claim_batch',
                         'fn_campaign_resolve_uncertain','fn_campaign_dispatch_targets')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;
