-- Mensagem de GRUPO do WhatsApp não emite evento de mensagem.
--
-- `trg_messages_emit_event` grava um evento (`message.received`,
-- `message.sent`, ...) para TODA linha inserida em `messages`. Quem consome esse
-- evento: push para o celular e o navegador de toda a organização, a análise de
-- sentimento (chamada de IA paga por mensagem), as automações do usuário, o
-- follow-up e os webhooks de saída configurados no CRM. Enquanto grupo não
-- virava conversa (antes da 0276) nada disso via mensagem de grupo; depois dela,
-- cada mensagem de cada participante passou a disparar tudo — um grupo movimenta
-- dezenas de mensagens por hora.
--
-- O corte é AQUI, no ponto único, e não em cada consumidor: um consumidor novo
-- já nasce sem receber grupo. É a regra W-09 do catálogo (a mensagem de grupo é
-- gravada, mas não vira trabalho) levada até o fim. Consulta a conversa (PK) em
-- vez de confiar em `messages.metadata`, para valer também para o que sai pelo
-- composer do CRM e pelo celular do dono.

create or replace function public.fn_emit_message_event() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_event text;
begin
  if exists (
    select 1 from public.conversations c
     where c.id = new.conversation_id and c.is_group
  ) then
    return new;
  end if;

  if new.direction = 'inbound' then
    v_event := 'message.received';
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;

  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', left(new.body, 280)
    )
  );
  return new;
end$$;
