import { beforeAll, describe, expect, it } from "vitest";

import { countAs, GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — RASTREIO DE CLIQUES (migration 0284).
 *
 * Prova, contra o banco que o self-hoster recebe:
 *   - só o token de quem RECEBEU a mensagem resolve; lixo, injeção e token nunca enviado dão nada;
 *   - só clique de pessoa (`browser`) marca "clicou" e gera o evento, uma vez; pré-visualização do
 *     WhatsApp e robô ficam gravados mas NÃO contam;
 *   - grupo encerrado como LOTADO redireciona para o ativo; encerrado à mão, não;
 *   - clique repetido em 10 segundos é um só; a trilha de cliques é append-only.
 */

const ORG = GOV_ORG;
const q = (script: string): string => lastLine(sql(script));
const json = <T = Record<string, unknown>>(script: string): T => JSON.parse(q(script)) as T;
let base = 500_000_000 + Math.floor(Math.random() * 400_000_000);
let seq = 0;

beforeAll(() => {
  seedGov();
});

interface Montagem {
  camp: string;
  canal: string;
  d1: string;
  cc: string;
  token: string;
}

/** Uma campanha rodando com UM contato já ENVIADO ao destino BLACK #01. */
function enviado(): Montagem {
  const canal = q(`select gen_random_uuid()::text`);
  sql(`insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
         values ('${canal}', '${ORG}', 'rast-${Date.now().toString(36)}-${++seq}', '\\x00'::bytea, 'WORKING')`);
  base += 1;
  const contato = q(`insert into public.contacts (organization_id, display_name, phone_number) values ('${ORG}', 'Rast ${base}', '+5511${base}') returning id`);
  const camp = q(`select public.fn_campaign_create('${ORG}', 'Rast ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
  sql(`
    select public.fn_campaign_create_version('${ORG}', '${camp}', 'Entre: {{link_grupo}}', '${GOV_ADMIN}');
    select public.fn_campaign_set_channels('${ORG}', '${camp}', array['${canal}'::uuid], '${GOV_ADMIN}');
    insert into public.campaign_contacts (organization_id, campaign_id, contact_id) values ('${ORG}', '${camp}', '${contato}');
  `);
  const d1 = json<{ destination_id: string }>(
    `select public.fn_campaign_add_destination('${ORG}', '${camp}', 'BLACK #01', 'https://chat.whatsapp.com/BLACK0001', null, 950, '${GOV_ADMIN}', true)::text`,
  ).destination_id;
  sql(`select public.fn_campaign_transition('${ORG}', '${camp}', 'start', '${GOV_ADMIN}')`);
  const [linha] = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${canal}', 1, 90, true)`).split("\n");
  const [cc, tk] = linha!.split("|") as [string, string];
  sql(`select public.fn_campaign_begin_send('${ORG}', '${cc}', '${tk}'); select public.fn_campaign_mark_sent('${ORG}', '${cc}', '${tk}', null, 'ext')`);
  const token = q(`select tracking_token from public.campaign_contacts where id = '${cc}'`);
  return { camp, canal, d1, cc, token };
}

const alvo = (token: string) => q(`select coalesce(public.fn_campaign_click_target('${token.replace(/'/g, "''")}')::text, 'null')`);
const registrar = (m: Montagem, classe: string, destino?: string, de: string | null = null) =>
  q(`select public.fn_campaign_record_click('${m.token}', '${destino ?? m.d1}', ${de ? `'${de}'` : "null"}, '${classe}')`);
const cliques = (cc: string, classe?: string) =>
  Number(q(`select count(*) from public.campaign_clicks where campaign_contact_id = '${cc}'${classe ? ` and agent_class = '${classe}'` : ""}`));
const eventos = (cc: string) => Number(q(`select count(*) from public.campaign_events where campaign_contact_id = '${cc}' and kind = 'clicked'`));
const clicou = (cc: string) => q(`select clicked_at is not null from public.campaign_contacts where id = '${cc}'`);

describe("Central de Disparos — resolver o link rastreável", () => {
  it("resolve o token de quem recebeu para o convite do destino que ele recebeu", () => {
    const m = enviado();
    expect(json<Record<string, unknown>>(`select public.fn_campaign_click_target('${m.token}')::text`)).toMatchObject({
      campaign_contact_id: m.cc,
      campaign_id: m.camp,
      destination_id: m.d1,
      url: "https://chat.whatsapp.com/BLACK0001",
      from_destination_id: null,
    });
  });

  it("não resolve lixo, injeção, token de outra forma ou token de quem NUNCA recebeu", () => {
    const m = enviado();
    for (const ruim of ["", "abc", "'; drop table campaigns; --", "ZZZZZZZZZZZZZZZZZZZZ", `${m.token}0`, m.token.toUpperCase(), "00000000000000000000"]) {
      expect(alvo(ruim), ruim).toBe("null");
    }
    // Contato importado mas nunca enviado: tem token, sem destino carimbado.
    base += 1;
    const contato = q(`insert into public.contacts (organization_id, display_name, phone_number) values ('${ORG}', 'Nunca ${base}', '+5511${base}') returning id`);
    sql(`insert into public.campaign_contacts (organization_id, campaign_id, contact_id) values ('${ORG}', '${m.camp}', '${contato}')`);
    const tokenNaoEnviado = q(`select tracking_token from public.campaign_contacts where campaign_id = '${m.camp}' and contact_id = '${contato}'`);
    expect(alvo(tokenNaoEnviado)).toBe("null");
  });

  it("grupo LOTADO redireciona para o destino ativo; o de envio continua sendo o contado", () => {
    const m = enviado();
    const d2 = json<{ destination_id: string }>(
      `select public.fn_campaign_add_destination('${ORG}', '${m.camp}', 'BLACK #02', 'https://chat.whatsapp.com/BLACK0002', null, 950, '${GOV_ADMIN}', true, '${m.d1}', 'full')::text`,
    ).destination_id;
    expect(json<Record<string, unknown>>(`select public.fn_campaign_click_target('${m.token}')::text`)).toMatchObject({
      destination_id: d2,
      url: "https://chat.whatsapp.com/BLACK0002",
      from_destination_id: m.d1,
    });
    // "Direcionados" segue por destino de ENVIO.
    expect(q(`select destination_id = '${m.d1}' from public.campaign_contacts where id = '${m.cc}'`)).toBe("t");
  });

  it("grupo encerrado À MÃO não redireciona: a decisão foi outra", () => {
    const m = enviado();
    sql(`select public.fn_campaign_add_destination('${ORG}', '${m.camp}', 'BLACK #02', 'https://chat.whatsapp.com/BLACK0002', null, 950, '${GOV_ADMIN}', true, '${m.d1}', 'manual')`);
    expect(json<Record<string, unknown>>(`select public.fn_campaign_click_target('${m.token}')::text`)).toMatchObject({
      destination_id: m.d1,
      url: "https://chat.whatsapp.com/BLACK0001",
    });
  });

  it("link antigo continua valendo depois que a campanha termina", () => {
    const m = enviado();
    sql(`select public.fn_campaign_transition('${ORG}', '${m.camp}', 'complete', '${GOV_ADMIN}')`);
    expect(json<Record<string, unknown>>(`select public.fn_campaign_click_target('${m.token}')::text`)).toMatchObject({ url: "https://chat.whatsapp.com/BLACK0001" });
  });
});

describe("Central de Disparos — registrar o clique", () => {
  it("clique de PESSOA marca 'clicou' e gera UM evento, com a versão e o destino do momento", () => {
    const m = enviado();
    expect(clicou(m.cc)).toBe("f");
    expect(registrar(m, "browser")).toBe("ok");
    expect(clicou(m.cc)).toBe("t");
    expect(eventos(m.cc)).toBe(1);
    expect(q(`select (destination_id = '${m.d1}')::text from public.campaign_events where campaign_contact_id = '${m.cc}' and kind = 'clicked'`)).toBe("true");
    expect(json(`select public.fn_campaign_counts('${ORG}', '${m.camp}')::text`)).toMatchObject({ clicked: 1 });
  });

  it("pré-visualização do WhatsApp e robô ficam gravados mas NÃO contam como pessoa", () => {
    const m = enviado();
    expect(registrar(m, "preview")).toBe("ok");
    expect(registrar(m, "bot")).toBe("ok");
    expect(cliques(m.cc)).toBe(2);
    expect(clicou(m.cc)).toBe("f");
    expect(eventos(m.cc)).toBe(0);
    expect(json(`select public.fn_campaign_counts('${ORG}', '${m.camp}')::text`)).toMatchObject({ clicked: 0 });
  });

  it("clique repetido em 10 segundos é um só; depois disso entra outra linha, mas o evento continua UM", () => {
    const m = enviado();
    expect(registrar(m, "browser")).toBe("ok");
    expect(registrar(m, "browser")).toBe("duplicate");
    expect(cliques(m.cc, "browser")).toBe(1);
    // A trilha é append-only para os papéis do PostgREST; o DONO da tabela (esta sessão) pode envelhecer a linha.
    sql(`update public.campaign_clicks set occurred_at = now() - interval '1 minute' where campaign_contact_id = '${m.cc}'`);
    expect(registrar(m, "browser")).toBe("ok");
    expect(cliques(m.cc, "browser")).toBe(2);
    expect(eventos(m.cc)).toBe(1);
  });

  it("guarda para onde o clique foi e de onde veio quando o grupo estava lotado", () => {
    const m = enviado();
    const d2 = json<{ destination_id: string }>(
      `select public.fn_campaign_add_destination('${ORG}', '${m.camp}', 'BLACK #02', 'https://chat.whatsapp.com/BLACK0002', null, 950, '${GOV_ADMIN}', true, '${m.d1}', 'full')::text`,
    ).destination_id;
    expect(registrar(m, "browser", d2, m.d1)).toBe("ok");
    expect(q(`select (destination_id = '${d2}')::text || '/' || (from_destination_id = '${m.d1}')::text from public.campaign_clicks where campaign_contact_id = '${m.cc}'`)).toBe("true/true");
  });

  it("token desconhecido não grava nada; classe inválida é recusada", () => {
    const m = enviado();
    expect(q(`select public.fn_campaign_record_click('00000000000000000000', null, null, 'browser')`)).toBe("unknown");
    expect(() => sql(`select public.fn_campaign_record_click('${m.token}', '${m.d1}', null, 'humano')`)).toThrow(/campaign_invalid_action/);
    expect(cliques(m.cc)).toBe(0);
  });

  it("a trilha de cliques é append-only e o navegador só lê a da própria organização", () => {
    for (const priv of ["update", "delete", "truncate"]) {
      expect(q(`select has_table_privilege('service_role', 'public.campaign_clicks', '${priv}')`), priv).toBe("f");
    }
    for (const priv of ["insert", "update", "delete"]) {
      expect(q(`select has_table_privilege('authenticated', 'public.campaign_clicks', '${priv}')`), priv).toBe("f");
      expect(q(`select has_table_privilege('anon', 'public.campaign_clicks', '${priv}')`), `anon ${priv}`).toBe("f");
    }
    expect(q(`select relrowsecurity from pg_class where oid = 'public.campaign_clicks'::regclass`)).toBe("t");
    const m = enviado();
    registrar(m, "browser");
    expect(countAs(GOV_ADMIN, `select count(*) from public.campaign_clicks where campaign_id = '${m.camp}'`)).toBe(1);
    const outra = "dddddddd-1111-4000-8000-0000000000c1";
    sql(`insert into public.organizations (id, slug, legal_name, display_name) values ('dddddddd-0000-4000-8000-0000000000c1', 'rast-b', 'Rast B', 'Rast B') on conflict do nothing;
         insert into auth.users (id, email) values ('${outra}', 'rast-b@invariant.test') on conflict do nothing;
         insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${outra}', 'dddddddd-0000-4000-8000-0000000000c1', 'admin', now()) on conflict do nothing`);
    expect(countAs(outra, `select count(*) from public.campaign_clicks where campaign_id = '${m.camp}'`)).toBe(0);
  });

  it("as funções são só do servidor", () => {
    for (const fn of ["fn_campaign_click_target", "fn_campaign_record_click"]) {
      expect(q(`select has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("f");
      expect(q(`select has_function_privilege('service_role', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("t");
    }
  });
});
