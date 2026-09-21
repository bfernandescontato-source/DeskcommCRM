import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — LEITURAS (migration 0285).
 *
 * Usa uma organização PRÓPRIA (nenhuma outra suíte escreve nela), porque o painel geral soma a
 * organização inteira e o número só é determinístico num terreno limpo.
 *
 * Prova que o que a tela mostra vem da FONTE (as linhas de `campaign_contacts`):
 *   - o funil e as quebras por versão, destino e número somam exatamente o que foi enviado;
 *   - "quantos o BLACK #01 recebeu" é por destino de ENVIO e não muda quando o grupo é trocado;
 *   - o painel conta só o que é da organização, e só as campanhas ativas para cliques/respostas;
 *   - nome de quem mudou algo só aparece para membro da própria organização.
 */

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const OUTRA = "eeeeeeee-0000-4000-8000-000000000002";
const USER = "eeeeeeee-1111-4000-8000-000000000001";
const USER_DE_FORA = "eeeeeeee-1111-4000-8000-000000000002";
const CANAL = "eeeeeeee-2222-4000-8000-000000000001";

const q = (script: string): string => lastLine(sql(script));
const json = <T = Record<string, unknown>>(script: string): T => JSON.parse(q(script)) as T;
let base = 600_000_000 + Math.floor(Math.random() * 300_000_000);

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'leit-a', 'Leituras A', 'Leituras A'), ('${OUTRA}', 'leit-b', 'Leituras B', 'Leituras B') on conflict do nothing;
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${USER}', 'bruno@invariant.test', '{"full_name":"Bruno Fernandes"}'::jsonb),
      ('${USER_DE_FORA}', 'fora@invariant.test', '{"full_name":"Pessoa de Fora"}'::jsonb) on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER}', '${ORG}', 'admin', now()), ('${USER_DE_FORA}', '${OUTRA}', 'admin', now()) on conflict do nothing;
    do $f$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${CANAL}', '${ORG}', 'leit-canal', '\\x00'::bytea, 'WORKING');
    exception when unique_violation then null; end $f$;
  `);
});

interface Reserva {
  id: string;
  token: string;
}
function reservar(camp: string): Reserva | undefined {
  const l = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${CANAL}', 1, 90, false)`).split("\n")[0];
  if (!l || !l.includes("|")) return undefined;
  const [id, token] = l.split("|") as [string, string];
  return { id, token };
}
function enviar(camp: string, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = reservar(camp)!;
    sql(`select public.fn_campaign_begin_send('${ORG}', '${r.id}', '${r.token}'); select public.fn_campaign_mark_sent('${ORG}', '${r.id}', '${r.token}', null, 'e')`);
    ids.push(r.id);
  }
  return ids;
}
function campanha(contatos: number): { camp: string; d1: string } {
  const camp = q(`select public.fn_campaign_create('${ORG}', 'Leit ${Math.random().toString(36).slice(2, 8)}', '${USER}')`);
  const inicio = base;
  base += contatos + 1;
  sql(`
    select public.fn_campaign_create_version('${ORG}', '${camp}', 'V1 {{link_grupo}}', '${USER}');
    select public.fn_campaign_set_channels('${ORG}', '${camp}', array['${CANAL}'::uuid], '${USER}');
    with c as (insert into public.contacts (organization_id, display_name, phone_number)
      select '${ORG}', 'L ' || g, '+5511' || (${inicio} + g)::text from generate_series(1, ${contatos}) g returning id)
    insert into public.campaign_contacts (organization_id, campaign_id, contact_id) select '${ORG}', '${camp}', id from c;
  `);
  const d1 = json<{ destination_id: string }>(
    `select public.fn_campaign_add_destination('${ORG}', '${camp}', 'BLACK #01', 'https://chat.whatsapp.com/BLACK0001', null, 950, '${USER}', true)::text`,
  ).destination_id;
  sql(`select public.fn_campaign_transition('${ORG}', '${camp}', 'start', '${USER}')`);
  return { camp, d1 };
}

interface Metricas {
  by_version: Array<{ version_no: number; sent: number; clicked: number; replied: number; failed: number }>;
  by_destination: Array<{ name: string; status: string; directed: number; clicked: number; joined: number; left: number; clicks_raw: number; capacity: number }>;
  by_channel: Array<{ channel_session_id: string; sent: number; failed: number; uncertain: number }>;
}
const metricas = (camp: string) => json<Metricas>(`select public.fn_campaign_metrics('${ORG}', '${camp}')::text`);

describe("Central de Disparos — métricas por versão, destino e número", () => {
  it("V1 x V2: enviados, cliques e respostas de cada versão, somando exatamente o que saiu", () => {
    const { camp } = campanha(10);
    const v1 = enviar(camp, 4);
    sql(`select public.fn_campaign_create_version('${ORG}', '${camp}', 'V2 {{link_grupo}}', '${USER}')`);
    const v2 = enviar(camp, 3);
    sql(`update public.campaign_contacts set clicked_at = now() where id in ('${v1[0]}', '${v1[1]}', '${v2[0]}');
         update public.campaign_contacts set replied_at = now() where id = '${v2[1]}'`);
    const m = metricas(camp);
    expect(m.by_version).toEqual([
      { version_no: 1, version_id: expect.any(String), sent: 4, clicked: 2, replied: 0, failed: 0 },
      { version_no: 2, version_id: expect.any(String), sent: 3, clicked: 1, replied: 1, failed: 0 },
    ]);
    expect(m.by_version.reduce((a, v) => a + v.sent, 0)).toBe(7);
    expect(json<{ sent: number; total: number }>(`select public.fn_campaign_counts('${ORG}', '${camp}')::text`)).toMatchObject({ sent: 7, total: 10 });
  });

  it("por destino: quantos foram direcionados a cada grupo, e isso não muda quando o grupo é trocado", () => {
    const { camp, d1 } = campanha(10);
    enviar(camp, 3);
    const d2 = json<{ destination_id: string }>(
      `select public.fn_campaign_add_destination('${ORG}', '${camp}', 'BLACK #02', 'https://chat.whatsapp.com/BLACK0002', null, 950, '${USER}', true, '${d1}', 'full')::text`,
    ).destination_id;
    enviar(camp, 2);
    sql(`update public.campaign_contacts set clicked_at = now(), joined_at = now() where campaign_id = '${camp}' and destination_id = '${d1}' and clicked_at is null and id = (select id from public.campaign_contacts where campaign_id = '${camp}' and destination_id = '${d1}' limit 1);
         update public.campaign_contacts set left_at = now() where id = (select id from public.campaign_contacts where campaign_id = '${camp}' and joined_at is not null limit 1)`);
    const m = metricas(camp);
    expect(m.by_destination.map((d) => `${d.name}:${d.status}:${d.directed}`)).toEqual(["BLACK #01:closed:3", "BLACK #02:active:2"]);
    expect(m.by_destination[0]).toMatchObject({ clicked: 1, joined: 1, left: 1, capacity: 950 });
    expect(m.by_destination[1]).toMatchObject({ clicked: 0, joined: 0, left: 0 });
    expect(d2).toBeTruthy();
  });

  it("cliques brutos contam só pessoa (navegador), não pré-visualização nem robô", () => {
    const { camp, d1 } = campanha(4);
    const [cc] = enviar(camp, 1) as [string];
    const token = q(`select tracking_token from public.campaign_contacts where id = '${cc}'`);
    for (const classe of ["preview", "bot"]) sql(`select public.fn_campaign_record_click('${token}', '${d1}', null, '${classe}')`);
    sql(`select public.fn_campaign_record_click('${token}', '${d1}', null, 'browser')`);
    expect(metricas(camp).by_destination[0]).toMatchObject({ clicks_raw: 1, clicked: 1 });
  });

  it("por número: enviados, falhas e incertos", () => {
    const { camp } = campanha(6);
    enviar(camp, 2);
    const f = reservar(camp)!;
    sql(`select public.fn_campaign_begin_send('${ORG}', '${f.id}', '${f.token}'); select public.fn_campaign_mark_failed('${ORG}', '${f.id}', '${f.token}', 'x', 'y', false)`);
    const u = reservar(camp)!;
    sql(`select public.fn_campaign_begin_send('${ORG}', '${u.id}', '${u.token}'); select public.fn_campaign_mark_uncertain('${ORG}', '${u.id}', '${u.token}', 't', 'z')`);
    const ch = metricas(camp).by_channel;
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ channel_session_id: CANAL, sent: 2, failed: 1, uncertain: 1 });
  });

  it("campanha de outra organização não é lida", () => {
    const { camp } = campanha(2);
    expect(() => sql(`select public.fn_campaign_metrics('${OUTRA}', '${camp}')`)).toThrow(/campaign_not_found/);
  });
});

describe("Central de Disparos — os sete números do topo", () => {
  it("conta a organização inteira: em andamento, enviados hoje e, nas campanhas ativas, pendentes/cliques/respostas/entradas/falhas", () => {
    const a = campanha(6);
    const b = campanha(4);
    const enviadosA = enviar(a.camp, 3);
    enviar(b.camp, 1);
    sql(`update public.campaign_contacts set clicked_at = now() where id = '${enviadosA[0]}';
         update public.campaign_contacts set replied_at = now() where id = '${enviadosA[1]}';
         update public.campaign_contacts set joined_at = now() where id = '${enviadosA[0]}'`);
    sql(`select public.fn_campaign_transition('${ORG}', '${b.camp}', 'pause', '${USER}')`);
    const p = json<{ running: number; paused: number; sent_today: number; active: Record<string, number> }>(
      `select public.fn_campaign_dashboard('${ORG}', now() - interval '1 day')::text`,
    );
    expect(p.running).toBeGreaterThanOrEqual(1);
    expect(p.paused).toBeGreaterThanOrEqual(1);
    expect(p.sent_today).toBeGreaterThanOrEqual(4);
    expect(p.active).toMatchObject({ clicked: expect.any(Number), replied: expect.any(Number), joined: expect.any(Number) });
    expect(p.active.clicked!).toBeGreaterThanOrEqual(1);
    expect(p.active.replied!).toBeGreaterThanOrEqual(1);
    // Encerrar tira a campanha das "ativas", mas o que ela enviou continua contando em "enviados hoje".
    const antes = p.sent_today;
    sql(`select public.fn_campaign_transition('${ORG}', '${a.camp}', 'complete', '${USER}')`);
    const depois = json<{ sent_today: number; active: Record<string, number> }>(`select public.fn_campaign_dashboard('${ORG}', now() - interval '1 day')::text`);
    expect(depois.sent_today).toBe(antes);
    expect(depois.active.clicked!).toBeLessThan(p.active.clicked!);
  });

  it("'enviados hoje' respeita o instante inicial; o painel de outra organização não vê nada", () => {
    const { camp } = campanha(3);
    enviar(camp, 2);
    const futuro = json<{ sent_today: number }>(`select public.fn_campaign_dashboard('${ORG}', now() + interval '1 hour')::text`);
    expect(futuro.sent_today).toBe(0);
    const vazia = json<{ running: number; sent_today: number; active: Record<string, number> }>(`select public.fn_campaign_dashboard('${OUTRA}', now() - interval '1 day')::text`);
    expect(vazia).toMatchObject({ running: 0, paused: 0, sent_today: 0, active: {} });
  });
});

describe("Central de Disparos — nomes de quem fez a mudança", () => {
  it("devolve o nome só de quem é membro DESTA organização", () => {
    const linhas = sql(`select id || '|' || name from public.fn_campaign_actor_names('${ORG}', array['${USER}'::uuid, '${USER_DE_FORA}'::uuid])`)
      .split("\n")
      .filter(Boolean);
    expect(linhas).toEqual([`${USER}|Bruno Fernandes`]);
    expect(sql(`select count(*) from public.fn_campaign_actor_names('${ORG}', null)`)).toBe("0");
  });

  it("sem nome no perfil, cai no começo do e-mail", () => {
    sql(`update auth.users set raw_user_meta_data = '{}'::jsonb where id = '${USER}'`);
    try {
      expect(q(`select name from public.fn_campaign_actor_names('${ORG}', array['${USER}'::uuid])`)).toBe("bruno");
    } finally {
      sql(`update auth.users set raw_user_meta_data = '{"full_name":"Bruno Fernandes"}'::jsonb where id = '${USER}'`);
    }
  });

  it("as três leituras são só do servidor", () => {
    for (const fn of ["fn_campaign_metrics", "fn_campaign_dashboard", "fn_campaign_actor_names"]) {
      expect(q(`select has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("f");
      expect(q(`select has_function_privilege('service_role', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("t");
    }
  });
});
