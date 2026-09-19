-- Quem falou, nas mensagens de GRUPO que já estavam gravadas.
--
-- A ingestão passa a gravar, em `messages.metadata`, `group_participant` (id do
-- remetente), `group_participant_name` (o nome que ele usa no WhatsApp, quando
-- informa) e `group_participant_phone` (E.164). As mensagens que chegaram antes
-- disso ficaram sem nada disso — e a tela, sem como dizer de quem é cada uma.
--
-- Os dados não se perderam: o corpo cru de cada evento está em
-- `webhook_events_log`, ligado à mensagem pelo mesmo `external_id`. Aqui eles
-- são copiados para a linha da mensagem.
--
-- IDEMPOTENTE: só toca mensagem de grupo, de entrada, que ainda não tem
-- `group_participant` — reaplicar não reescreve nada. Não vai para o baseline
-- (é correção de dado, não de schema).

with origem as (
  select distinct on (m.id)
         m.id as message_id,
         nullif(l.payload_parsed->'payload'->>'participant', '') as jid,
         nullif(l.payload_parsed->'payload'->'_data'->'key'->>'participantAlt', '') as jid_alt,
         nullif(btrim(coalesce(
           l.payload_parsed->'payload'->'_data'->>'pushName',
           l.payload_parsed->'payload'->'_data'->>'notifyName', '')), '') as nome
    from public.messages m
    join public.webhook_events_log l
      on l.organization_id = m.organization_id
     and l.provider = 'waha'
     and l.external_id = m.external_id
   where m.metadata->>'is_group' = 'true'
     and m.direction = 'inbound'
     and m.metadata->>'group_participant' is null
   order by m.id, l.received_at desc
)
update public.messages m
   set metadata = m.metadata || jsonb_strip_nulls(jsonb_build_object(
         'group_participant', o.jid,
         'group_participant_name', left(o.nome, 120),
         'group_participant_phone',
           case
             when o.jid_alt ~ '^[0-9]{8,15}@(s\.whatsapp\.net|c\.us)$' then '+' || split_part(o.jid_alt, '@', 1)
             when o.jid     ~ '^[0-9]{8,15}@(s\.whatsapp\.net|c\.us)$' then '+' || split_part(o.jid, '@', 1)
           end))
  from origem o
 where m.id = o.message_id
   and o.jid is not null;
