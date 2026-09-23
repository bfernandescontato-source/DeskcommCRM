-- Central de Disparos — "BLOQUEAR CONTATO" (0287): um link na própria mensagem que a pessoa
-- usa pra dizer "não me manda mais nada desta campanha", com efeito imediato e de verdade.
--
-- Decisão do dono (21/09): o bloqueio vale só PARA ESTA CAMPANHA — não impede a pessoa de
-- entrar numa lista futura, diferente da campanha atual. O que ele garante de verdade: nenhuma
-- tentativa de reenvio DENTRO desta campanha volta a mandar mensagem pra ela — nem o despacho
-- normal (que nunca tocaria de novo uma linha já enviada) nem o "tentar de novo" manual de um
-- envio incerto, que é o único jeito de um contato já enviado voltar à fila.
--
-- `blocked_at` é um carimbo de ENGAJAMENTO, igual a `clicked_at`/`replied_at`/`joined_at`: não
-- mexe em `status` (a máquina de ENTREGA). A pessoa recebeu a mensagem (por isso tem o link pra
-- clicar) — o que muda é só se um reenvio futuro é permitido.

alter table public.campaign_contacts add column if not exists blocked_at timestamptz;

-- "Quantas pessoas bloquearam esta campanha?" — pergunta do painel, respondida por índice.
create index if not exists idx_campaign_contacts_blocked
  on public.campaign_contacts (campaign_id) where blocked_at is not null;

-- ═══ A. UM EVENTO NOVO NA LINHA DO TEMPO ══════════════════════════════════════
alter table public.campaign_events drop constraint if exists campaign_events_kind_check;
alter table public.campaign_events add constraint campaign_events_kind_check check (kind in (
  'created','ready','started','paused','resumed','completed','cancelled','errored',
  'imported','settings_changed',
  'version_created','version_activated',
  'destination_added','destination_changed',
  'channel_added','channel_removed',
  'sent','send_failed','uncertain','skipped',
  'clicked','replied','joined','left','removed','blocked'
));

-- ═══ B. REGISTRAR O BLOQUEIO (o link da mensagem chama isto) ══════════════════
-- Idempotente: clicar duas vezes (rede duplicando, pessoa impaciente) devolve 'already', não
-- grava evento de novo. Token que não existe devolve 'unknown' — a rota pública nunca inventa
-- "bloqueado" pra quem não está em campanha nenhuma.
create or replace function public.fn_campaign_block_contact(p_token text)
returns text language plpgsql security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype;
begin
  select * into cc from public.campaign_contacts where tracking_token = p_token for update;
  if not found then return 'unknown'; end if;
  if cc.blocked_at is not null then return 'already'; end if;

  update public.campaign_contacts set blocked_at = now(), updated_at = now() where id = cc.id;
  perform public.fn_campaign_log(cc.organization_id, cc.campaign_id, 'blocked', null, cc.id,
    cc.message_version_id, cc.destination_id, cc.channel_session_id, '{}'::jsonb, 'blocked:' || cc.id);
  return 'ok';
end $f$;

-- ═══ C. O "TENTAR DE NOVO" MANUAL RESPEITA O BLOQUEIO ═════════════════════════
-- Mesma função da 0282, com UMA linha a mais: se a pessoa já bloqueou esta campanha, 'retry'
-- não a devolve pra fila. `sent` e `failed` (confirmar o que já aconteceu, não reenviar) continuam
-- valendo igual — só o reenvio de verdade é que respeita o bloqueio.
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

  if p_resolution = 'retry' and cc.blocked_at is not null then
    return 'blocked';
  end if;

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

-- ═══ D. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fn_campaign_block_contact', 'fn_campaign_resolve_uncertain')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;

comment on column public.campaign_contacts.blocked_at is 'A pessoa clicou em "bloquear" na mensagem desta campanha. Não mexe em status (entrega); impede só reenvio manual futuro NESTA campanha.';
