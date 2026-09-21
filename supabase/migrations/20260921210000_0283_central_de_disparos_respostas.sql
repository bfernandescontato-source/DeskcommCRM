-- Central de Disparos — RESPOSTAS (0283): a conversa da campanha e o "respondeu".
--
-- ─── O PROBLEMA ────────────────────────────────────────────────────────────────
-- Uma campanha de 45 mil contatos, enviada como o Inbox envia, criaria 45 mil
-- conversas ABERTAS: cada uma dispara o roteamento (atribuir a atendente), entra na
-- fila e nos contadores, e `fn_service_begin` ainda REABRE a conversa fechada de quem
-- já foi cliente. Um broadcast não pode ocupar a operação de atendimento — só a RESPOSTA
-- de alguém deve.
--
-- ─── A SOLUÇÃO: NASCER ARQUIVADA, ACORDAR NA RESPOSTA ──────────────────────────
-- A conversa que a campanha cria nasce `archived`. Isso a tira, sem tocar em nenhuma
-- tela nem função do atendimento, de tudo o que trabalha: a lista padrão do Inbox e as
-- contagens (status terminal), o roteamento (`fn_request_channel_routing` só pega
-- open/pending/claimed/ai_handling) e a fila. Quando a pessoa RESPONDE, o mecanismo que já
-- existe faz o resto: `fn_service_inbound` reabre uma conversa arquivada (status `open`,
-- abre a demanda) e `trg_service_reopened_routing` a roteia como qualquer entrada nova.
-- É o comportamento de uma conversa antiga que volta a falar — reaproveitado, não reescrito.
--
-- Conversa que JÁ EXISTIA (cliente que conversava com a equipe) NÃO é tocada: a mensagem da
-- campanha entra nela como qualquer outra, sem reabrir, sem rotear, sem escondê-la.
--
-- ─── "RESPONDEU" ───────────────────────────────────────────────────────────────
-- Trigger na mensagem que CHEGA: a primeira resposta (reação e mensagem de sistema não
-- contam) dentro de 7 dias do último envio da campanha àquela pessoa marca
-- `campaign_contacts.replied_at` e grava o evento `replied`, uma vez só. É trigger e não
-- consumidor de `event_log` porque o efeito é só de banco (nunca HTTP) e o operador quer ver
-- "Respondeu" na hora, não daqui a um minuto. E ele NUNCA pode impedir a mensagem de
-- chegar: qualquer erro dentro dele é engolido.

-- ═══ A. ABRIR A CONVERSA DA CAMPANHA ══════════════════════════════════════════
create or replace function public.fn_campaign_open_conversation(p_org uuid, p_contact uuid, p_channel uuid)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare v_id uuid; v_created boolean;
begin
  if not exists (select 1 from public.contacts
                  where id = p_contact and organization_id = p_org
                    and not is_anonymized and is_merged_into is null) then
    raise exception 'campaign_contact_unavailable' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.channel_sessions
                  where id = p_channel and organization_id = p_org and archived_at is null) then
    raise exception 'campaign_invalid_channel' using errcode = 'P0001';
  end if;

  -- O mesmo mutex de serviço que a entrada de mensagem usa: a campanha e a resposta da pessoa
  -- não criam a conversa ao mesmo tempo.
  perform public.fn_service_lock(p_org, p_contact);

  select id into v_id from public.conversations
   where organization_id = p_org and contact_id = p_contact and channel_session_id = p_channel
     and not is_group
   order by last_message_at desc nulls last, created_at desc limit 1;
  if v_id is not null then
    return jsonb_build_object('conversation_id', v_id, 'created', false);
  end if;

  insert into public.conversations
    (organization_id, contact_id, channel_session_id, channel, status, is_group,
     unread_count_for_assignee, metadata, status_changed_at, service_closed_at)
  values
    (p_org, p_contact, p_channel, 'whatsapp', 'archived', false,
     0, '{}'::jsonb, clock_timestamp(), clock_timestamp())
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
    do update set updated_at = now()
  returning id, (xmax = 0) into v_id, v_created;
  return jsonb_build_object('conversation_id', v_id, 'created', v_created);
end $f$;

-- ═══ B. "RESPONDEU" ═══════════════════════════════════════════════════════════
create or replace function public.fn_campaign_on_inbound_message()
returns trigger language plpgsql security definer set search_path = public as $f$
declare cc public.campaign_contacts%rowtype; v_when timestamptz := coalesce(new.sent_at, now());
begin
  begin
    if new.direction is distinct from 'inbound' or new.contact_id is null
       or new.type in ('reaction', 'system') then
      return null;
    end if;
    -- O último envio da campanha a esta pessoa nos 7 dias anteriores. A tolerância de 2 minutos
    -- cobre o relógio do celular (o carimbo da resposta vem de lá, o do envio é o do banco).
    select * into cc from public.campaign_contacts
     where organization_id = new.organization_id and contact_id = new.contact_id
       and status = 'sent' and sent_at is not null
       and sent_at <= v_when + interval '2 minutes' and sent_at > v_when - interval '7 days'
     order by sent_at desc limit 1;
    if found and cc.replied_at is null then
      update public.campaign_contacts set replied_at = v_when, updated_at = now()
       where id = cc.id and replied_at is null;
      if found then
        perform public.fn_campaign_log(cc.organization_id, cc.campaign_id, 'replied', null, cc.id,
          cc.message_version_id, cc.destination_id, cc.channel_session_id,
          jsonb_build_object('message_id', new.id), 'replied:' || cc.id);
      end if;
    end if;
  exception when others then
    -- Responder ao cliente nunca falha por causa da campanha.
    null;
  end;
  return null;
end $f$;

drop trigger if exists trg_campaign_on_inbound_message on public.messages;
create trigger trg_campaign_on_inbound_message
  after insert on public.messages
  for each row when (new.direction = 'inbound')
  execute function public.fn_campaign_on_inbound_message();

-- ═══ C. EXECUTE: SÓ O SERVIDOR ════════════════════════════════════════════════
do $f$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fn_campaign_open_conversation', 'fn_campaign_on_inbound_message')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $f$;
