-- Grupo do WhatsApp passa a virar conversa no Inbox, sem reabrir o "deal
-- infinito" que a 0027 cortou: em vez de um contato por remetente, um único
-- CONTATO-FANTASMA por grupo (identidade = o próprio chat id do grupo, não
-- quem fala nele).
--
-- ADITIVA DE PROPÓSITO. A primeira ideia era um terceiro ramo na coluna gerada
-- `contacts.wa_identity`, mas coluna gerada não aceita ALTER de expressão: teria
-- que ser dropada e recriada, o que (a) reescreve a tabela inteira sob lock
-- exclusivo, (b) derruba em silêncio todo objeto que depende dela — o
-- `idx_contacts_avatar_refresh`, por exemplo — e (c) mexe na chave de conflito
-- de todo upsert 1-para-1. Um índice único parcial NOVO resolve a mesma
-- deduplicação sem tocar em nada que já existe: contato-fantasma fica com
-- `wa_identity` NULL (nenhum leitor de `wa_identity` o enxerga) e a chave dele
-- é `source_metadata->>'waha_group_chat_id'`.
--
-- A IA continua sem responder em grupo (regra dura nº 12, em
-- `lib/agent-engine/edge/crm/drain.ts`) e nenhum lead nasce de mensagem de
-- grupo (`aplicarEfeitosPosEntrada` nunca é chamado pelo caminho de grupo) —
-- esta migration não mexe em nenhum dos dois.

-- A. Uma linha por grupo por organização. É a garantia de banco contra o
-- "deal infinito": duas mensagens do mesmo grupo, de pessoas diferentes,
-- caem no MESMO contato-fantasma.
create unique index if not exists uniq_contacts_org_group_chat
  on public.contacts (organization_id, (source_metadata->>'waha_group_chat_id'))
  where source_metadata->>'waha_group_chat_id' is not null and is_merged_into is null;

-- B. Upsert do contato-fantasma do grupo — irmã de `fn_upsert_wa_contact`,
-- nunca a substitui. `phone_number` fica null de propósito (não é uma
-- pessoa); o nome vem do assunto do grupo quando o WAHA o informa.
create or replace function public.fn_upsert_wa_group_contact(
  p_org uuid, p_chat_id text, p_subject text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
  values (p_org, null, 'whatsapp_group', '{}'::jsonb, '{}'::text[],
    jsonb_build_object('waha_group_chat_id', p_chat_id, 'group_subject', nullif(p_subject, '')),
    coalesce(nullif(p_subject, ''), 'Grupo do WhatsApp'))
  on conflict (organization_id, (source_metadata->>'waha_group_chat_id'))
    where source_metadata->>'waha_group_chat_id' is not null and is_merged_into is null
  do update set
    display_name = coalesce(nullif(p_subject, ''), contacts.display_name),
    source_metadata = contacts.source_metadata || jsonb_build_object('group_subject', nullif(p_subject, '')),
    updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

-- C. Upsert da conversa de grupo — irmã de `fn_upsert_wa_conversation`. Usa o
-- `on conflict` na constraint de 4 colunas que a 0027 já deixou pronta
-- (`conversations_unique_per_contact_session`), nunca usada até aqui porque
-- nada gravava `group_chat_id`.
create or replace function public.fn_upsert_wa_group_conversation(
  p_org uuid, p_contact uuid, p_session uuid, p_group_chat_id text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, group_chat_id, unread_count_for_assignee, metadata)
  values (p_org, p_contact, p_session, 'whatsapp', 'open', true, p_group_chat_id, 0, '{}'::jsonb)
  on conflict (organization_id, contact_id, channel_session_id, group_chat_id)
  do update set updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

revoke all on function public.fn_upsert_wa_group_contact(uuid, text, text) from public;
revoke all on function public.fn_upsert_wa_group_conversation(uuid, uuid, uuid, text) from public;
grant execute on function public.fn_upsert_wa_group_contact(uuid, text, text) to service_role;
grant execute on function public.fn_upsert_wa_group_conversation(uuid, uuid, uuid, text) to service_role;

comment on function public.fn_upsert_wa_group_contact is 'Contato-fantasma por grupo do WhatsApp: um só por chat id, nunca um por participante.';
comment on function public.fn_upsert_wa_group_conversation is 'Conversa de grupo do WhatsApp; is_group=true sempre, jamais dispara lead ou IA.';
