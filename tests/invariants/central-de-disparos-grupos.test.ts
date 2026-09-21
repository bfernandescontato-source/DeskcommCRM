import { beforeAll, describe, expect, it } from "vitest";

import { countAs, GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — ENTRADAS E SAÍDAS DE GRUPO (migration 0286).
 *
 * Prova, contra o banco que o self-hoster recebe, que "entrou/saiu do grupo" só nasce de EVIDÊNCIA:
 *   - o aviso do WhatsApp liga ao contato ENVIADO por telefone (qualquer variante) ou por `wa_lid`;
 *   - quem não é reconhecido é gravado como `unattributed` e conta como membro do grupo, sem virar
 *     "esta pessoa da campanha entrou";
 *   - CLIQUE nunca infere entrada; grupo que não é destino de campanha não é gravado;
 *   - o mesmo aviso (dois números no grupo, entrega repetida) é UM evento;
 *   - saída depois de entrada, reentrada e aviso fora de ordem terminam no estado certo;
 *   - o telefone cru do participante não fica gravado; a trilha é append-only e isolada por organização.
 */

const ORG = GOV_ORG;
const q = (script: string): string => lastLine(sql(script));
const json = <T = Record<string, unknown>>(script: string): T => JSON.parse(q(script)) as T;
let base = 700_000_000 + Math.floor(Math.random() * 200_000_000);
let seq = 0;

beforeAll(() => {
  seedGov();
});

interface Contato {
  id: string;
  cc: string;
  phone: string;
}
interface Montagem {
  camp: string;
  canal: string;
  d1: string;
  grupo: string;
  contato: Contato;
}

const novoGrupo = () => `1203630${Date.now().toString().slice(-8)}${++seq}@g.us`;
const novoCanal = () => {
  const canal = q(`select gen_random_uuid()::text`);
  sql(`insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
         values ('${canal}', '${ORG}', 'grp-${Date.now().toString(36)}-${++seq}', '\\x00'::bytea, 'WORKING')`);
  return canal;
};

/** Cria um contato e o coloca na campanha (ainda PENDENTE). */
function contatoNaCampanha(camp: string, extra = ""): Contato {
  base += 1;
  const phone = `+5511${base}`;
  const id = q(`insert into public.contacts (organization_id, display_name, phone_number${extra ? ", source_metadata" : ""}) values ('${ORG}', 'Grp ${base}', '${phone}'${extra ? `, '${extra}'::jsonb` : ""}) returning id`);
  const cc = q(`insert into public.campaign_contacts (organization_id, campaign_id, contact_id) values ('${ORG}', '${camp}', '${id}') returning id`);
  return { id, cc, phone };
}

/** Campanha rodando, com um destino que TEM `group_chat_id`, e um contato já ENVIADO a ele. */
function enviado(extraDoContato = ""): Montagem {
  const canal = novoCanal();
  const camp = q(`select public.fn_campaign_create('${ORG}', 'Grp ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
  const grupo = novoGrupo();
  const contato = contatoNaCampanha(camp, extraDoContato);
  sql(`
    select public.fn_campaign_create_version('${ORG}', '${camp}', 'Entre: {{link_grupo}}', '${GOV_ADMIN}');
    select public.fn_campaign_set_channels('${ORG}', '${camp}', array['${canal}'::uuid], '${GOV_ADMIN}');
  `);
  const d1 = json<{ destination_id: string }>(
    `select public.fn_campaign_add_destination('${ORG}', '${camp}', 'BLACK #01', 'https://chat.whatsapp.com/GRP${seq}${Date.now().toString(36)}', '${grupo}', 950, '${GOV_ADMIN}', true)::text`,
  ).destination_id;
  sql(`select public.fn_campaign_transition('${ORG}', '${camp}', 'start', '${GOV_ADMIN}')`);
  const [linha] = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${canal}', 1, 90, true)`).split("\n");
  const [cc, tk] = linha!.split("|") as [string, string];
  sql(`select public.fn_campaign_begin_send('${ORG}', '${cc}', '${tk}'); select public.fn_campaign_mark_sent('${ORG}', '${cc}', '${tk}', null, 'ext')`);
  return { camp, canal, d1, grupo, contato };
}

const T = (h: number, m = 0, s = 0) => `2026-09-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;
const aviso = (m: Montagem, tipo: "join" | "leave", ref: string, quando: string, opc: { variantes?: string[] | null; lid?: string | null; canal?: string; grupo?: string } = {}) => {
  const variantes = opc.variantes === undefined ? [m.contato.phone] : opc.variantes;
  return json<{ matched_destinations: number; recorded: number; attributed: number }>(
    `select public.fn_campaign_record_group_event('${ORG}', '${opc.canal ?? m.canal}', '${opc.grupo ?? m.grupo}', '${tipo}', '${ref}', ${variantes ? `array[${variantes.map((v) => `'${v}'`).join(",")}]::text[]` : "null"}, ${opc.lid ? `'${opc.lid}'` : "null"}, '${quando}'::timestamptz)::text`,
  );
};
const contato = (cc: string) => json<{ j: string | null; l: string | null }>(`select json_build_object('j', joined_at, 'l', left_at)::text from public.campaign_contacts where id = '${cc}'`);
const linhas = (camp: string) => Number(q(`select count(*) from public.campaign_group_events where campaign_id = '${camp}'`));
const metricas = (m: Montagem) =>
  json<{ by_destination: Array<Record<string, number | string>> }>(`select public.fn_campaign_metrics('${ORG}', '${m.camp}')::text`).by_destination.find((d) => d.destination_id === m.d1)!;

describe("Central de Disparos — entradas e saídas de grupo (0286)", () => {
  it("o aviso de ENTRADA marca o contato enviado, por telefone, e gera o evento 'joined' uma vez", () => {
    const m = enviado();
    expect(aviso(m, "join", `${m.contato.phone.slice(1)}@c.us`, T(15))).toEqual({ matched_destinations: 1, recorded: 1, attributed: 1 });
    expect(contato(m.contato.cc).j).not.toBeNull();
    expect(contato(m.contato.cc).l).toBeNull();
    expect(q(`select attribution from public.campaign_group_events where campaign_id = '${m.camp}'`)).toBe("phone_match");
    expect(Number(q(`select count(*) from public.campaign_events where campaign_contact_id = '${m.contato.cc}' and kind = 'joined'`))).toBe(1);
  });

  it("é idempotente: o mesmo aviso de novo, ou visto por OUTRO número do mesmo grupo, é um evento só", () => {
    const m = enviado();
    const ref = `${m.contato.phone.slice(1)}@c.us`;
    aviso(m, "join", ref, T(15));
    expect(aviso(m, "join", ref, T(15))).toEqual({ matched_destinations: 1, recorded: 0, attributed: 0 });
    expect(aviso(m, "join", ref, T(15), { canal: novoCanal() })).toMatchObject({ recorded: 0 });
    expect(linhas(m.camp)).toBe(1);
    expect(Number(q(`select count(*) from public.campaign_events where campaign_contact_id = '${m.contato.cc}' and kind = 'joined'`))).toBe(1);
  });

  it("atribui por LID quando o WhatsApp só informa o identificador (contatos.wa_lid)", () => {
    // O seed de governança já ocupa alguns LIDs: um identificador novo mantém este
    // cenário isolado quando os invariantes rodam juntos no mesmo banco.
    const lid = `grp-lid-${Date.now()}-${++seq}`;
    const m = enviado(`{"waha_lid":"${lid}@lid"}`);
    // Sem telefone no aviso: só o LID.
    expect(aviso(m, "join", `${lid}@lid`, T(15), { variantes: null, lid })).toMatchObject({ recorded: 1, attributed: 1 });
    expect(q(`select attribution from public.campaign_group_events where campaign_id = '${m.camp}'`)).toBe("lid_match");
    expect(contato(m.contato.cc).j).not.toBeNull();
  });

  it("quem NÃO é reconhecido é gravado como sem atribuição, conta como membro e não mexe em ninguém", () => {
    const m = enviado();
    expect(aviso(m, "join", "5511900000001@c.us", T(15), { variantes: ["+5511900000001"] })).toEqual({ matched_destinations: 1, recorded: 1, attributed: 0 });
    expect(q(`select attribution || '/' || (campaign_contact_id is null)::text from public.campaign_group_events where campaign_id = '${m.camp}'`)).toBe("unattributed/true");
    expect(contato(m.contato.cc)).toEqual({ j: null, l: null });
    expect(metricas(m)).toMatchObject({ members: 1, joined_total: 1, members_left: 0, joined: 0 });
  });

  it("só atribui a contato JÁ ENVIADO: pendente na mesma campanha não vira 'entrou'", () => {
    const m = enviado();
    const pendente = contatoNaCampanha(m.camp);
    expect(aviso(m, "join", `${pendente.phone.slice(1)}@c.us`, T(15), { variantes: [pendente.phone] })).toMatchObject({ recorded: 1, attributed: 0 });
    expect(contato(pendente.cc).j).toBeNull();
  });

  it("grupo que NÃO é destino de campanha não é gravado (nem o telefone de quem entra)", () => {
    const m = enviado();
    const antes = Number(q(`select count(*) from public.campaign_group_events`));
    expect(aviso(m, "join", `${m.contato.phone.slice(1)}@c.us`, T(15), { grupo: "1203639999999999@g.us" })).toEqual({ matched_destinations: 0, recorded: 0, attributed: 0 });
    expect(Number(q(`select count(*) from public.campaign_group_events`))).toBe(antes);
    expect(contato(m.contato.cc).j).toBeNull();
  });

  it("CLIQUE nunca infere entrada: quem clicou e nunca apareceu num aviso de grupo continua só 'clicou'", () => {
    const m = enviado();
    const token = q(`select tracking_token from public.campaign_contacts where id = '${m.contato.cc}'`);
    expect(q(`select public.fn_campaign_record_click('${token}', '${m.d1}', null, 'browser')`)).toBe("ok");
    const c = json<{ c: string | null; j: string | null }>(`select json_build_object('c', clicked_at, 'j', joined_at)::text from public.campaign_contacts where id = '${m.contato.cc}'`);
    expect(c.c).not.toBeNull();
    expect(c.j).toBeNull();
    expect(Number(q(`select count(*) from public.campaign_events where campaign_contact_id = '${m.contato.cc}' and kind = 'joined'`))).toBe(0);
  });

  it("saída depois de entrada marca a saída; nova entrada volta a contar como 'está no grupo'", () => {
    const m = enviado();
    const ref = `${m.contato.phone.slice(1)}@c.us`;
    aviso(m, "join", ref, T(15));
    aviso(m, "leave", ref, T(16));
    expect(contato(m.contato.cc).l).not.toBeNull();
    expect(metricas(m)).toMatchObject({ members: 0, members_left: 1, joined_total: 1 });
    aviso(m, "join", ref, T(17));
    expect(contato(m.contato.cc).l).toBeNull();
    expect(contato(m.contato.cc).j).toMatch(/15:00:00/); // a PRIMEIRA entrada é a que fica
    expect(metricas(m)).toMatchObject({ members: 1, members_left: 0, joined_total: 1 });
  });

  it("aviso FORA DE ORDEM: uma saída mais antiga que a entrada registrada não desfaz a entrada", () => {
    const m = enviado();
    const ref = `${m.contato.phone.slice(1)}@c.us`;
    aviso(m, "join", ref, T(17)); // chegou primeiro, mas é o mais novo
    aviso(m, "leave", ref, T(16)); // mais antigo: a pessoa saiu ANTES de voltar
    expect(contato(m.contato.cc).l).toBeNull();
    expect(linhas(m.camp)).toBe(2); // o aviso fica registrado, só não muda o estado
    expect(metricas(m)).toMatchObject({ members: 1 });
  });

  it("saída de quem NUNCA vimos entrar marca só a saída — entrada não se inventa", () => {
    const m = enviado();
    aviso(m, "leave", `${m.contato.phone.slice(1)}@c.us`, T(16));
    expect(contato(m.contato.cc).j).toBeNull();
    expect(contato(m.contato.cc).l).not.toBeNull();
  });

  it("o mesmo grupo em DUAS campanhas atribui cada uma a seu contato", () => {
    const a = enviado();
    // Segunda campanha reutilizando o MESMO grupo e o MESMO telefone.
    const canal = novoCanal();
    const camp = q(`select public.fn_campaign_create('${ORG}', 'Grp2 ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
    const c2 = q(`insert into public.campaign_contacts (organization_id, campaign_id, contact_id) values ('${ORG}', '${camp}', '${a.contato.id}') returning id`);
    sql(`select public.fn_campaign_create_version('${ORG}', '${camp}', 'Entre: {{link_grupo}}', '${GOV_ADMIN}');
         select public.fn_campaign_set_channels('${ORG}', '${camp}', array['${canal}'::uuid], '${GOV_ADMIN}');
         select public.fn_campaign_add_destination('${ORG}', '${camp}', 'BLACK #X', 'https://chat.whatsapp.com/DUP${Date.now().toString(36)}', '${a.grupo}', 900, '${GOV_ADMIN}', true);
         select public.fn_campaign_transition('${ORG}', '${camp}', 'start', '${GOV_ADMIN}')`);
    const [linha] = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${canal}', 1, 90, true)`).split("\n");
    const [cc, tk] = linha!.split("|") as [string, string];
    sql(`select public.fn_campaign_begin_send('${ORG}', '${cc}', '${tk}'); select public.fn_campaign_mark_sent('${ORG}', '${cc}', '${tk}', null, 'ext2')`);
    expect(cc).toBe(c2);
    expect(aviso(a, "join", `${a.contato.phone.slice(1)}@c.us`, T(15))).toEqual({ matched_destinations: 2, recorded: 2, attributed: 2 });
    expect(contato(a.contato.cc).j).not.toBeNull();
    expect(contato(c2).j).not.toBeNull();
  });

  it("o telefone cru do participante NÃO fica gravado: só o md5, e a tabela não tem coluna de telefone", () => {
    const m = enviado();
    const ref = `${m.contato.phone.slice(1)}@c.us`;
    aviso(m, "join", ref, T(15));
    expect(q(`select participant_key = md5(lower('${ref}')) from public.campaign_group_events where campaign_id = '${m.camp}'`)).toBe("t");
    expect(Number(q(`select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'campaign_group_events' and (column_name ilike '%phone%' or column_name ilike '%participant_ref%' or column_name ilike '%jid%')`))).toBe(0);
    expect(q(`select bool_and(row_to_json(g)::text not like '%${m.contato.phone.slice(1)}%') from public.campaign_group_events g where campaign_id = '${m.camp}'`)).toBe("t");
  });

  it("métricas: pessoas distintas que entraram, as que estão no grupo agora e as que saíram", () => {
    const m = enviado();
    const p = (n: number) => `55119000000${n}@c.us`;
    for (const [n, tipo, t] of [[1, "join", T(10)], [2, "join", T(10, 1)], [3, "join", T(10, 2)], [2, "leave", T(11)], [3, "leave", T(11, 1)], [3, "join", T(12)]] as const) {
      aviso(m, tipo, p(n), t, { variantes: [`+55119000000${n}`] });
    }
    // 1 e 3 estão no grupo; 2 saiu. Três pessoas distintas entraram.
    expect(metricas(m)).toMatchObject({ members: 2, members_left: 1, joined_total: 3 });
  });

  it("aviso inválido é recusado (tipo desconhecido, participante vazio)", () => {
    const m = enviado();
    expect(() => aviso(m, "promote" as never, "5511@c.us", T(15))).toThrow(/campaign_group_event_invalid/);
    expect(() => aviso(m, "join", "  ", T(15))).toThrow(/campaign_group_event_invalid/);
    expect(linhas(m.camp)).toBe(0);
  });

  it("a trilha é append-only, o navegador só lê a da própria organização e a função é só do servidor", () => {
    for (const priv of ["update", "delete", "truncate"]) {
      expect(q(`select has_table_privilege('service_role', 'public.campaign_group_events', '${priv}')`), priv).toBe("f");
    }
    for (const priv of ["insert", "update", "delete"]) {
      expect(q(`select has_table_privilege('authenticated', 'public.campaign_group_events', '${priv}')`), priv).toBe("f");
      expect(q(`select has_table_privilege('anon', 'public.campaign_group_events', '${priv}')`), `anon ${priv}`).toBe("f");
    }
    expect(q(`select relrowsecurity from pg_class where oid = 'public.campaign_group_events'::regclass`)).toBe("t");
    const m = enviado();
    aviso(m, "join", `${m.contato.phone.slice(1)}@c.us`, T(15));
    expect(countAs(GOV_ADMIN, `select count(*) from public.campaign_group_events where campaign_id = '${m.camp}'`)).toBe(1);
    const outra = "dddddddd-1111-4000-8000-0000000000d1";
    sql(`insert into public.organizations (id, slug, legal_name, display_name) values ('dddddddd-0000-4000-8000-0000000000d1', 'grp-b', 'Grp B', 'Grp B') on conflict do nothing;
         insert into auth.users (id, email) values ('${outra}', 'grp-b@invariant.test') on conflict do nothing;
         insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${outra}', 'dddddddd-0000-4000-8000-0000000000d1', 'admin', now()) on conflict do nothing`);
    expect(countAs(outra, `select count(*) from public.campaign_group_events where campaign_id = '${m.camp}'`)).toBe(0);
    for (const fn of ["fn_campaign_record_group_event", "fn_campaign_metrics"]) {
      expect(q(`select has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("f");
      expect(q(`select has_function_privilege('service_role', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("t");
    }
  });

  it("aba Atividade: existe índice parcial só para os eventos da campanha (sem contato)", () => {
    expect(q(`select count(*) from pg_indexes where schemaname = 'public' and indexname = 'idx_campaign_events_campaign_only'`)).toBe("1");
  });
});
