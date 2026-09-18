-- O NOME do contato-fantasma de um grupo do WhatsApp vem do WAHA (o `subject`
-- do grupo), nunca de quem escreveu nele.
--
-- A 0276 recebia o nome como parâmetro e a aplicação passava `notifyName` — que
-- é o nome da PESSOA que falou. Resultado medido em produção: grupo batizado
-- com o nome da última pessoa a escrever, e grupo "sem nome" quando ela não
-- tinha um. Duas correções:
--
--  1. A função só toca no nome quando recebe um nome de verdade. Antes,
--     `p_subject` nulo gravava `group_subject: null` por cima do que já havia
--     (o `||` de jsonb sobrescreve a chave, mesmo com valor null).
--  2. `group_name_source = 'waha'` marca o nome que veio do grupo. Quem não tem
--     a marca é nome herdado do remetente e volta ao padrão até a aplicação
--     buscar o verdadeiro — o UPDATE abaixo só toca esses, então reaplicar a
--     migration não apaga nome que já foi resolvido.

create or replace function public.fn_upsert_wa_group_contact(
  p_org uuid, p_chat_id text, p_subject text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_nome text := nullif(btrim(coalesce(p_subject, '')), '');
begin
  insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
  values (p_org, null, 'whatsapp_group', '{}'::jsonb, '{}'::text[],
    jsonb_build_object('waha_group_chat_id', p_chat_id)
      || case when v_nome is not null
           then jsonb_build_object('group_subject', v_nome, 'group_name_source', 'waha')
           else '{}'::jsonb end,
    coalesce(v_nome, 'Grupo do WhatsApp'))
  on conflict (organization_id, (source_metadata->>'waha_group_chat_id'))
    where source_metadata->>'waha_group_chat_id' is not null and is_merged_into is null
  do update set
    display_name = coalesce(v_nome, contacts.display_name),
    source_metadata = contacts.source_metadata
      || case when v_nome is not null
           then jsonb_build_object('group_subject', v_nome, 'group_name_source', 'waha')
           else '{}'::jsonb end,
    updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

-- `create or replace` preserva os privilégios, mas repetir o fechamento deixa
-- a migration autossuficiente (mesma regra da 0276).
revoke execute on function public.fn_upsert_wa_group_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_upsert_wa_group_contact(uuid, text, text) to service_role;

-- Nomes herdados do remetente (gravados pela 0276 antes desta correção).
update public.contacts
   set display_name = 'Grupo do WhatsApp',
       source_metadata = source_metadata - 'group_subject'
 where source = 'whatsapp_group'
   and source_metadata->>'group_name_source' is distinct from 'waha';
