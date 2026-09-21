import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — RESPOSTAS (migration 0283).
 *
 * Prova, contra o banco que o self-hoster recebe:
 *
 *   - a conversa que a campanha cria NÃO ocupa o atendimento: nasce arquivada, não é
 *     roteada e não entra em fila nenhuma;
 *   - conversa que já existia (aberta ou fechada) NÃO é tocada pela campanha;
 *   - quando a pessoa RESPONDE, o mecanismo que o CRM já tem reabre e roteia a conversa
 *     (é a premissa do desenho — por isso é medida aqui, com o baseline de verdade);
 *   - "Respondeu" é marcado uma vez, só por resposta de verdade, dentro do prazo;
 *   - o gatilho de resposta NUNCA impede a mensagem de chegar.
 */

const ORG = GOV_ORG;
const q = (script: string): string => lastLine(sql(script));
const json = <T = Record<string, unknown>>(script: string): T => JSON.parse(q(script)) as T;
let base = 400_000_000 + Math.floor(Math.random() * 500_000_000);
let seq = 0;

beforeAll(() => {
  seedGov();
});

function novoCanal(): string {
  const id = q(`select gen_random_uuid()::text`);
  sql(`insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
         values ('${id}', '${ORG}', 'resp-${Date.now().toString(36)}-${++seq}', '\\x00'::bytea, 'WORKING')`);
  return id;
}
function novoContato(): string {
  base += 1;
  return q(`insert into public.contacts (organization_id, display_name, phone_number) values ('${ORG}', 'Resp ${base}', '+5511${base}') returning id`);
}
const abrir = (contato: string, canal: string) =>
  json<{ conversation_id: string; created: boolean }>(`select public.fn_campaign_open_conversation('${ORG}', '${contato}', '${canal}')::text`);
const status = (conv: string) => q(`select status from public.conversations where id = '${conv}'`);
const roteamentos = (conv: string) =>
  Number(q(`select count(*) from public.event_log where event_type = 'conversation.routing_requested' and entity_id = '${conv}'`));

/** Uma campanha com um contato JÁ ENVIADO (passa pela máquina de verdade). */
function enviado(): { camp: string; cc: string; contato: string; canal: string; conv: string } {
  const canal = novoCanal();
  const contato = novoContato();
  const camp = q(`select public.fn_campaign_create('${ORG}', 'Resp ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
  sql(`
    select public.fn_campaign_create_version('${ORG}', '${camp}', 'Oi', '${GOV_ADMIN}');
    select public.fn_campaign_set_channels('${ORG}', '${camp}', array['${canal}'::uuid], '${GOV_ADMIN}');
    insert into public.campaign_contacts (organization_id, campaign_id, contact_id) values ('${ORG}', '${camp}', '${contato}');
    select public.fn_campaign_transition('${ORG}', '${camp}', 'start', '${GOV_ADMIN}');
  `);
  const [linha] = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${canal}', 1, 90, true)`).split("\n");
  const [cc, token] = linha!.split("|") as [string, string];
  sql(`select public.fn_campaign_begin_send('${ORG}', '${cc}', '${token}')`);
  sql(`select public.fn_campaign_mark_sent('${ORG}', '${cc}', '${token}', null, 'ext')`);
  const conv = abrir(contato, canal).conversation_id;
  return { camp, cc, contato, canal, conv };
}

function chega(conv: string, contato: string, canal: string, extra: { type?: string; when?: string } = {}): void {
  seq += 1;
  sql(`insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, body, sent_at)
         values ('${ORG}', '${conv}', '${canal}', '${contato}', 'in-${Date.now().toString(36)}-${seq}', '${extra.type ?? "text"}', 'inbound', 'received', 'oi', ${extra.when ? `'${extra.when}'::timestamptz` : "now()"})`);
}
const respondeu = (cc: string) => q(`select replied_at is not null from public.campaign_contacts where id = '${cc}'`);
const eventosDeResposta = (cc: string) => Number(q(`select count(*) from public.campaign_events where campaign_contact_id = '${cc}' and kind = 'replied'`));

describe("Central de Disparos — a conversa da campanha não ocupa o atendimento", () => {
  it("nasce ARQUIVADA, sem roteamento, e repetir devolve a mesma conversa", () => {
    const canal = novoCanal();
    const contato = novoContato();
    const a = abrir(contato, canal);
    expect(a.created).toBe(true);
    expect(status(a.conversation_id)).toBe("archived");
    expect(roteamentos(a.conversation_id)).toBe(0);
    expect(q(`select is_group::text || '/' || channel from public.conversations where id = '${a.conversation_id}'`)).toBe("false/whatsapp");
    const b = abrir(contato, canal);
    expect(b).toEqual({ conversation_id: a.conversation_id, created: false });
    expect(Number(q(`select count(*) from public.conversations where organization_id = '${ORG}' and contact_id = '${contato}'`))).toBe(1);
  });

  it("conversa que JÁ EXISTIA não é tocada: aberta continua aberta; fechada continua fechada", () => {
    const canal = novoCanal();
    for (const estado of ["open", "closed"]) {
      const contato = novoContato();
      const existente = q(`insert into public.conversations (organization_id, contact_id, channel_session_id, status, is_group, channel, last_message_at)
                             values ('${ORG}', '${contato}', '${canal}', '${estado}', false, 'whatsapp', now()) returning id`);
      const r = abrir(contato, canal);
      expect(r, estado).toEqual({ conversation_id: existente, created: false });
      expect(status(existente), estado).toBe(estado);
    }
  });

  it("recusa contato anonimizado, mesclado ou de outra organização e canal arquivado", () => {
    const canal = novoCanal();
    const anon = novoContato();
    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${anon}'`);
    expect(() => sql(`select public.fn_campaign_open_conversation('${ORG}', '${anon}', '${canal}')`)).toThrow(/campaign_contact_unavailable/);
    expect(() => sql(`select public.fn_campaign_open_conversation('dddddddd-0000-4000-8000-00000000ffff', '${novoContato()}', '${canal}')`)).toThrow(/campaign_contact_unavailable/);
    sql(`update public.channel_sessions set archived_at = now() where id = '${canal}'`);
    expect(() => sql(`select public.fn_campaign_open_conversation('${ORG}', '${novoContato()}', '${canal}')`)).toThrow(/campaign_invalid_channel/);
  });
});

describe("Central de Disparos — a resposta acorda a conversa e marca 'Respondeu'", () => {
  it("a resposta REABRE a conversa arquivada e a roteia como qualquer entrada nova", () => {
    const e = enviado();
    expect(status(e.conv)).toBe("archived");
    expect(roteamentos(e.conv)).toBe(0);
    chega(e.conv, e.contato, e.canal);
    // O mecanismo que o CRM já tem (fn_service_inbound + trg_service_reopened_routing):
    expect(status(e.conv)).toBe("open");
    expect(roteamentos(e.conv)).toBeGreaterThanOrEqual(1);
    expect(q(`select current_demanda_id is not null from public.conversations where id = '${e.conv}'`)).toBe("t");
  });

  it("marca respondeu UMA vez, com a versão/destino/número que valiam no envio", () => {
    const e = enviado();
    expect(respondeu(e.cc)).toBe("f");
    chega(e.conv, e.contato, e.canal);
    expect(respondeu(e.cc)).toBe("t");
    expect(eventosDeResposta(e.cc)).toBe(1);
    expect(q(`select (channel_session_id = '${e.canal}')::text from public.campaign_events where campaign_contact_id = '${e.cc}' and kind = 'replied'`)).toBe("true");
    const primeira = q(`select replied_at::text from public.campaign_contacts where id = '${e.cc}'`);
    chega(e.conv, e.contato, e.canal);
    expect(eventosDeResposta(e.cc)).toBe(1);
    expect(q(`select replied_at::text from public.campaign_contacts where id = '${e.cc}'`)).toBe(primeira);
    expect(json(`select public.fn_campaign_counts('${ORG}', '${e.camp}')::text`)).toMatchObject({ replied: 1 });
  });

  it("reação, mensagem de sistema e o que a EQUIPE manda não contam como resposta", () => {
    const e = enviado();
    chega(e.conv, e.contato, e.canal, { type: "reaction" });
    chega(e.conv, e.contato, e.canal, { type: "system" });
    sql(`insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, body, sent_at)
           values ('${ORG}', '${e.conv}', '${e.canal}', '${e.contato}', 'out-${Date.now().toString(36)}-${++seq}', 'text', 'outbound', 'sent', 'oi', now())`);
    expect(respondeu(e.cc)).toBe("f");
    expect(eventosDeResposta(e.cc)).toBe(0);
  });

  it("resposta fora do prazo de 7 dias, ou de outra pessoa, não é atribuída à campanha", () => {
    const velho = enviado();
    sql(`update public.campaign_contacts set sent_at = now() - interval '8 days' where id = '${velho.cc}'`);
    chega(velho.conv, velho.contato, velho.canal);
    expect(respondeu(velho.cc)).toBe("f");

    const e = enviado();
    const outro = novoContato();
    const outraConv = abrir(outro, e.canal).conversation_id;
    chega(outraConv, outro, e.canal);
    expect(respondeu(e.cc)).toBe("f");
  });

  it("uma resposta ANTERIOR ao envio não é 'resposta' (a tolerância é só de 2 minutos)", () => {
    const e = enviado();
    chega(e.conv, e.contato, e.canal, { when: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
    expect(respondeu(e.cc)).toBe("f");
  });

  it("com vários envios recentes, a resposta vai para o MAIS RECENTE", () => {
    const e = enviado();
    const camp2 = q(`select public.fn_campaign_create('${ORG}', 'Segunda ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
    sql(`
      select public.fn_campaign_create_version('${ORG}', '${camp2}', 'Oi de novo', '${GOV_ADMIN}');
      select public.fn_campaign_set_channels('${ORG}', '${camp2}', array['${e.canal}'::uuid], '${GOV_ADMIN}');
      insert into public.campaign_contacts (organization_id, campaign_id, contact_id) values ('${ORG}', '${camp2}', '${e.contato}');
      select public.fn_campaign_transition('${ORG}', '${camp2}', 'start', '${GOV_ADMIN}');
    `);
    const [linha] = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp2}', '${e.canal}', 1, 90, true)`).split("\n");
    const [cc2, token] = linha!.split("|") as [string, string];
    sql(`select public.fn_campaign_begin_send('${ORG}', '${cc2}', '${token}'); select public.fn_campaign_mark_sent('${ORG}', '${cc2}', '${token}', null, 'ext2')`);
    chega(e.conv, e.contato, e.canal);
    expect(respondeu(cc2)).toBe("t");
    expect(respondeu(e.cc)).toBe("f");
  });

  it("o gatilho NUNCA impede a mensagem de chegar, mesmo que o registro da campanha falhe", () => {
    const e = enviado();
    const def = sql(`select pg_get_functiondef('public.fn_campaign_log(uuid, uuid, text, uuid, uuid, uuid, uuid, uuid, jsonb, text)'::regprocedure)`);
    sql(`create or replace function public.fn_campaign_log(
           p_org uuid, p_campaign uuid, p_kind text, p_actor uuid default null, p_campaign_contact uuid default null,
           p_version uuid default null, p_destination uuid default null, p_channel uuid default null,
           p_payload jsonb default '{}'::jsonb, p_key text default null
         ) returns void language plpgsql security definer set search_path = public as $$ begin raise exception 'campanha quebrada'; end $$`);
    try {
      chega(e.conv, e.contato, e.canal);
      // A mensagem chegou e a conversa foi reaberta pelo atendimento, apesar da falha da campanha.
      expect(Number(q(`select count(*) from public.messages where conversation_id = '${e.conv}' and direction = 'inbound'`))).toBe(1);
      expect(status(e.conv)).toBe("open");
      expect(respondeu(e.cc)).toBe("f");
    } finally {
      sql(def);
    }
    // Restaurada: a próxima resposta é marcada normalmente.
    chega(e.conv, e.contato, e.canal);
    expect(respondeu(e.cc)).toBe("t");
  });

  it("as funções são só do servidor", () => {
    for (const fn of ["fn_campaign_open_conversation", "fn_campaign_on_inbound_message"]) {
      expect(q(`select has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("f");
      expect(q(`select has_function_privilege('service_role', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("t");
    }
  });
});
