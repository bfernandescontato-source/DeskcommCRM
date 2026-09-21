import { beforeAll, describe, expect, it } from "vitest";

import { countAs, GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — NÚCLEO (migration 0280).
 *
 * O que este arquivo prova, contra o banco que o self-hoster de fato recebe
 * (`baseline.sql`), são os critérios de aceite que dependem SÓ do banco:
 *
 *   - pausar, recarregar e retomar do ponto exato, sem reenviar quem já recebeu;
 *   - trocar a mensagem e o grupo com a campanha rodando: só os PRÓXIMOS mudam,
 *     e quem já recebeu guarda a versão e o destino que viu;
 *   - worker que morre, evento repetido e reserva perdida não geram envio duplo;
 *   - contato bloqueado ou que recusou marketing nunca é enviado;
 *   - a trilha (`campaign_events`) é append-only até para o service_role;
 *   - uma organização não alcança a campanha da outra.
 *
 * ⚠️ O QUE ELE NÃO PROVA: corrida REAL entre duas conexões (dois workers no mesmo
 * instante). `sql()` roda uma sessão por chamada, e `for update skip locked` só
 * se manifesta com transações abertas em paralelo — o que aqui é raciocínio
 * (a reserva marca `queued` na mesma instrução que escolhe), não medição. A prova
 * de concorrência real é um teste com `pg`, e fica registrada como pendência.
 */

const ORG = GOV_ORG;
const ORG_B = "dddddddd-0000-4000-8000-00000000000b";
const USER_B = "dddddddd-1111-4000-8000-00000000000b";
const CH_A = "dddddddd-2222-4000-8000-00000000000a";
const CH_B = "dddddddd-2222-4000-8000-00000000000c";
const CH_OUTRA_ORG = "dddddddd-2222-4000-8000-00000000000d";

const TABELAS = [
  "campaigns",
  "campaign_message_versions",
  "campaign_destinations",
  "campaign_channels",
  "campaign_contacts",
  "campaign_events",
] as const;

const q = (script: string): string => lastLine(sql(script));
const json = <T = Record<string, unknown>>(script: string): T => JSON.parse(q(script)) as T;
function erro(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    return String((e as Error).message);
  }
}

let telefone = 100_000_000 + Math.floor(Math.random() * 700_000_000);

interface Reserva {
  id: string;
  token: string;
}
interface Envio {
  decision: string;
  [k: string]: unknown;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'disp-b', 'Disparos B', 'Disparos B') on conflict do nothing;
    insert into auth.users (id, email) values ('${USER_B}', 'disp-b@invariant.test') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'admin', now()) on conflict do nothing;
    -- Um DO por linha: a colisão de UMA (outro arquivo já criou o canal) não pode desfazer as demais.
    do $f$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${CH_A}', '${ORG}', 'disp-a', '\\x00'::bytea, 'WORKING');
    exception when unique_violation then null; end $f$;
    do $f$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${CH_B}', '${ORG}', 'disp-c', '\\x00'::bytea, 'WORKING');
    exception when unique_violation then null; end $f$;
    do $f$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${CH_OUTRA_ORG}', '${ORG_B}', 'disp-d', '\\x00'::bytea, 'WORKING');
    exception when unique_violation then null; end $f$;
  `);
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface Montagem {
  contatos?: number;
  canais?: string[];
  corpo?: string;
  comDestino?: boolean;
  iniciar?: boolean;
}
interface Campanha {
  id: string;
  destino1: string | null;
}

function montar(o: Montagem = {}): Campanha {
  const { contatos = 10, canais = [CH_A], corpo = "Oi {{nome}}, entre: {{link_grupo}}", comDestino = true, iniciar = true } = o;
  const id = q(`select public.fn_campaign_create('${ORG}', 'Teste ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
  sql(`select public.fn_campaign_create_version('${ORG}', '${id}', '${corpo}', '${GOV_ADMIN}')`);
  sql(`select public.fn_campaign_set_channels('${ORG}', '${id}', array[${canais.map((c) => `'${c}'::uuid`).join(",")}], '${GOV_ADMIN}')`);
  let destino1: string | null = null;
  if (comDestino) {
    destino1 = json<{ destination_id: string }>(
      `select public.fn_campaign_add_destination('${ORG}', '${id}', 'BLACK #01', 'https://chat.whatsapp.com/AAAA1111', null, 950, '${GOV_ADMIN}', true)::text`,
    ).destination_id;
  }
  if (contatos > 0) {
    const base = telefone;
    telefone += contatos + 1;
    sql(`
      with c as (
        insert into public.contacts (organization_id, display_name, phone_number)
        select '${ORG}', 'Contato ' || g, '+5511' || (${base} + g)::text from generate_series(1, ${contatos}) g
        returning id)
      insert into public.campaign_contacts (organization_id, campaign_id, contact_id)
      select '${ORG}', '${id}', id from c;
    `);
  }
  if (iniciar) sql(`select public.fn_campaign_transition('${ORG}', '${id}', 'start', '${GOV_ADMIN}')`);
  return { id, destino1 };
}

const transicao = (camp: string, acao: string, motivo = "null") =>
  json<{ changed: boolean; from: string; to: string; cancelled_contacts?: number }>(
    `select public.fn_campaign_transition('${ORG}', '${camp}', '${acao}', '${GOV_ADMIN}', ${motivo === "null" ? "null" : `'${motivo}'`})::text`,
  );

function reservar(camp: string, canal: string, n: number): Reserva[] {
  const out = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${canal}', ${n}, 90)`);
  return out
    .split("\n")
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [id, token] = l.split("|") as [string, string];
      return { id, token };
    });
}
const iniciarEnvio = (r: Reserva) =>
  json<Envio>(`select public.fn_campaign_begin_send('${ORG}', '${r.id}', '${r.token}')::text`);
const concluir = (r: Reserva) => q(`select public.fn_campaign_mark_sent('${ORG}', '${r.id}', '${r.token}', null, 'ext-${r.id.slice(0, 8)}')`);

/** Reserva, inicia e conclui `n` envios. Devolve as decisões. */
function enviar(camp: string, canal: string, n: number): Envio[] {
  return reservar(camp, canal, n).map((r) => {
    const d = iniciarEnvio(r);
    if (d.decision === "send") concluir(r);
    return d;
  });
}
const contagens = (camp: string) =>
  json<Record<string, number>>(`select public.fn_campaign_counts('${ORG}', '${camp}')::text`);

// ── segurança do schema ─────────────────────────────────────────────────────

describe("Central de Disparos — schema e permissões", () => {
  it("as seis tabelas têm RLS e o navegador só lê", () => {
    for (const t of TABELAS) {
      expect(q(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`), t).toBe("t");
      expect(q(`select has_table_privilege('authenticated', 'public.${t}', 'select')`), `${t} select`).toBe("t");
      for (const priv of ["insert", "update", "delete", "truncate"]) {
        expect(q(`select has_table_privilege('authenticated', 'public.${t}', '${priv}')`), `${t} ${priv}`).toBe("f");
        expect(q(`select has_table_privilege('anon', 'public.${t}', '${priv}')`), `anon ${t} ${priv}`).toBe("f");
      }
      expect(q(`select has_table_privilege('anon', 'public.${t}', 'select')`), `anon ${t} select`).toBe("f");
    }
  });

  it("nenhuma função da Central é executável por anon ou authenticated; service_role executa", () => {
    const total = Number(q(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'fn_campaign%'`));
    expect(total).toBeGreaterThanOrEqual(17);
    expect(
      q(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace
           and (proname like 'fn_campaign%' or proname = 'fn_redigir_disparos_do_contato_anonimizado')
           and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))`),
    ).toBe("0");
    expect(
      q(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'fn_campaign%'
           and not has_function_privilege('service_role', oid, 'execute')`),
    ).toBe("0");
  });

  it("a trilha é append-only até para o service_role, e as versões não se apagam", () => {
    for (const priv of ["update", "delete", "truncate"]) {
      expect(q(`select has_table_privilege('service_role', 'public.campaign_events', '${priv}')`), priv).toBe("f");
    }
    expect(q(`select has_table_privilege('service_role', 'public.campaign_message_versions', 'delete')`)).toBe("f");
    expect(q(`select has_table_privilege('service_role', 'public.campaign_events', 'insert')`)).toBe("t");
  });

  it("uma organização não alcança a campanha da outra, nem por leitura nem pelas funções", () => {
    const c = montar({ contatos: 3, iniciar: false });
    expect(countAs(GOV_ADMIN, `select count(*) from public.campaigns where id = '${c.id}'`)).toBe(1);
    expect(countAs(GOV_ADMIN, `select count(*) from public.campaign_contacts where campaign_id = '${c.id}'`)).toBe(3);
    expect(countAs(USER_B, `select count(*) from public.campaigns where id = '${c.id}'`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from public.campaign_contacts where campaign_id = '${c.id}'`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from public.campaign_events where campaign_id = '${c.id}'`)).toBe(0);
    for (const t of ["campaign_message_versions", "campaign_destinations", "campaign_channels"] as const) {
      expect(countAs(GOV_ADMIN, `select count(*) from public.${t} where campaign_id = '${c.id}'`), `${t} (dono)`).toBeGreaterThanOrEqual(1);
      expect(countAs(USER_B, `select count(*) from public.${t} where campaign_id = '${c.id}'`), `${t} (outra organização)`).toBe(0);
    }
    // Função recebendo a organização ERRADA não acha a campanha.
    expect(erro(`select public.fn_campaign_transition('${ORG_B}', '${c.id}', 'start')`)).toMatch(/campaign_not_found/);
    expect(erro(`select public.fn_campaign_create_version('${ORG_B}', '${c.id}', 'x')`)).toMatch(/campaign_not_found/);
    expect(erro(`select public.fn_campaign_set_channels('${ORG_B}', '${c.id}', array['${CH_OUTRA_ORG}'::uuid])`)).toMatch(/campaign_not_found/);
    expect(json(`select public.fn_campaign_counts('${ORG_B}', '${c.id}')::text`).total).toBe(0);
  });

  it("canal de outra organização não entra na campanha", () => {
    const c = montar({ contatos: 1, iniciar: false });
    expect(erro(`select public.fn_campaign_set_channels('${ORG}', '${c.id}', array['${CH_OUTRA_ORG}'::uuid])`)).toMatch(/campaign_invalid_channel/);
  });

  it("o destino ativo tem de ser DA campanha (FK composta) e só existe um ativo", () => {
    const a = montar({ contatos: 1, iniciar: false });
    const b = montar({ contatos: 1, iniciar: false });
    expect(erro(`update public.campaigns set active_destination_id = '${b.destino1}' where id = '${a.id}'`)).toMatch(/violates foreign key/);
    expect(erro(`insert into public.campaign_destinations (organization_id, campaign_id, sequence_no, name, invite_url, status, opened_at) values ('${ORG}', '${a.id}', 99, 'dup', 'https://x.test/a', 'active', now())`)).toMatch(/uniq_campaign_destinations_one_active|duplicate key/);
  });
});

// ── máquina de estados ──────────────────────────────────────────────────────

describe("Central de Disparos — estados da campanha", () => {
  it("não inicia sem contatos, mensagem, destino (se usa {{link_grupo}}) e canal — e diz qual falta, na ordem do assistente", () => {
    const id = q(`select public.fn_campaign_create('${ORG}', 'Vazia', '${GOV_ADMIN}')`);
    expect(erro(`select public.fn_campaign_transition('${ORG}', '${id}', 'start')`)).toMatch(/campaign_no_contacts/);
    sql(`
      with c as (insert into public.contacts (organization_id, display_name, phone_number) values ('${ORG}', 'Solo', '+5511${(telefone += 5)}') returning id)
      insert into public.campaign_contacts (organization_id, campaign_id, contact_id) select '${ORG}', '${id}', id from c`);
    expect(erro(`select public.fn_campaign_transition('${ORG}', '${id}', 'start')`)).toMatch(/campaign_no_message/);
    sql(`select public.fn_campaign_create_version('${ORG}', '${id}', 'Oi {{nome}}, entre: {{link_grupo}}', '${GOV_ADMIN}')`);
    expect(erro(`select public.fn_campaign_transition('${ORG}', '${id}', 'start')`)).toMatch(/campaign_no_destination/);
    sql(`select public.fn_campaign_add_destination('${ORG}', '${id}', 'BLACK #01', 'https://chat.whatsapp.com/ZZZ99999', null, null, '${GOV_ADMIN}', true)`);
    expect(erro(`select public.fn_campaign_transition('${ORG}', '${id}', 'start')`)).toMatch(/campaign_no_channel/);
    sql(`select public.fn_campaign_set_channels('${ORG}', '${id}', array['${CH_A}'::uuid])`);
    expect(transicao(id, "start")).toMatchObject({ changed: true, from: "draft", to: "running" });
  });

  it("repetir uma transição não muda nada; transição inválida e estado terminal são recusados", () => {
    const c = montar({ contatos: 4 });
    expect(transicao(c.id, "start")).toMatchObject({ changed: false, to: "running" });
    expect(transicao(c.id, "pause")).toMatchObject({ changed: true, from: "running", to: "paused" });
    expect(transicao(c.id, "pause")).toMatchObject({ changed: false });
    expect(transicao(c.id, "resume")).toMatchObject({ changed: true, to: "running" });
    expect(erro(`select public.fn_campaign_transition('${ORG}', '${c.id}', 'ready')`)).toMatch(/campaign_invalid_transition/);
    expect(transicao(c.id, "cancel")).toMatchObject({ changed: true, to: "cancelled" });
    expect(erro(`select public.fn_campaign_transition('${ORG}', '${c.id}', 'resume')`)).toMatch(/campaign_invalid_transition/);
    expect(transicao(c.id, "cancel")).toMatchObject({ changed: false });
    expect(erro(`select public.fn_campaign_transition('${ORG}', '${c.id}', 'voar')`)).toMatch(/campaign_invalid_action/);
  });

  it("ENCERRAR cancela o que não saiu, preserva o que saiu e todo o histórico", () => {
    const c = montar({ contatos: 6 });
    expect(enviar(c.id, CH_A, 2).map((d) => d.decision)).toEqual(["send", "send"]);
    const t = transicao(c.id, "complete");
    expect(t).toMatchObject({ changed: true, to: "completed", cancelled_contacts: 4 });
    expect(contagens(c.id)).toMatchObject({ total: 6, sent: 2, cancelled: 4, pending: 0 });
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'sent'`)).toBe("2");
    expect(q(`select count(*) from public.campaign_message_versions where campaign_id = '${c.id}'`)).toBe("1");
    expect(q(`select status || '/' || close_reason from public.campaign_destinations where id = '${c.destino1}'`)).toBe("closed/campaign_ended");
  });

  it("a campanha se encerra sozinha quando não resta nada por processar", () => {
    const c = montar({ contatos: 3 });
    expect(q(`select public.fn_campaign_complete_if_done('${ORG}', '${c.id}')`)).toBe("f");
    enviar(c.id, CH_A, 3);
    expect(q(`select public.fn_campaign_complete_if_done('${ORG}', '${c.id}')`)).toBe("t");
    expect(q(`select status from public.campaigns where id = '${c.id}'`)).toBe("completed");
    expect(q(`select payload->>'reason' from public.campaign_events where campaign_id = '${c.id}' and kind = 'completed'`)).toBe("all_processed");
  });
});

// ── pausar e retomar ────────────────────────────────────────────────────────

describe("Central de Disparos — pausar e retomar sem perder posição nem duplicar", () => {
  it("pausada não reserva; o que já estava reservado volta para a fila; retomar segue do ponto exato", () => {
    const c = montar({ contatos: 10 });
    const primeiros = enviar(c.id, CH_A, 3);
    expect(primeiros.every((d) => d.decision === "send")).toBe(true);

    const emVoo = reservar(c.id, CH_A, 2); // reservados, ainda não iniciados
    expect(emVoo).toHaveLength(2);
    expect(transicao(c.id, "pause", "manual").to).toBe("paused");

    expect(reservar(c.id, CH_A, 5)).toHaveLength(0);
    // Quem já tinha reserva descobre a pausa no ponto sem volta e NÃO envia.
    expect(iniciarEnvio(emVoo[0]!)).toMatchObject({ decision: "released", campaign_status: "paused" });
    expect(iniciarEnvio(emVoo[1]!)).toMatchObject({ decision: "released" });
    expect(contagens(c.id)).toMatchObject({ sent: 3, pending: 7, queued: 0, processing: 0 });
    expect(q(`select status_reason from public.campaigns where id = '${c.id}'`)).toBe("manual");

    expect(transicao(c.id, "resume").to).toBe("running");
    const resto = enviar(c.id, CH_A, 50);
    expect(resto).toHaveLength(7);
    expect(resto.every((d) => d.decision === "send")).toBe(true);
    // Ninguém recebeu duas vezes; ninguém ficou de fora.
    expect(contagens(c.id)).toMatchObject({ total: 10, sent: 10, pending: 0 });
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'sent'`)).toBe("10");
    expect(q(`select max(attempts) from public.campaign_contacts where campaign_id = '${c.id}'`)).toBe("1");
    expect(q(`select count(distinct campaign_contact_id) from public.campaign_events where campaign_id = '${c.id}' and kind = 'sent'`)).toBe("10");
  });

  it("a ordem da fila é a da importação, também depois de pausar", () => {
    const c = montar({ contatos: 6 });
    const a = reservar(c.id, CH_A, 2).map((r) => r.id);
    const menores = q(`select string_agg(id::text, ',' order by seq) from (select id, seq from public.campaign_contacts where campaign_id = '${c.id}' order by seq limit 2) x`);
    expect(a.join(",")).toBe(menores);
  });
});

// ── mensagem e destino durante a campanha ───────────────────────────────────

describe("Central de Disparos — trocar mensagem e destino com a campanha rodando", () => {
  it("V2 vale só para os próximos; quem recebeu V1 guarda V1; versões são imutáveis", () => {
    const c = montar({ contatos: 8 });
    enviar(c.id, CH_A, 3);
    const v2 = json<{ version_no: number; previous_version_no: number }>(
      `select public.fn_campaign_create_version('${ORG}', '${c.id}', 'Nova {{nome}}: {{link_grupo}}', '${GOV_ADMIN}', true, 1)::text`,
    );
    expect(v2).toMatchObject({ version_no: 2, previous_version_no: 1 });
    const depois = enviar(c.id, CH_A, 5);
    expect(depois.every((d) => d.version_no === 2 && String(d.body).startsWith("Nova"))).toBe(true);

    expect(q(`select count(*) from public.campaign_contacts cc join public.campaign_message_versions v on v.id = cc.message_version_id where cc.campaign_id = '${c.id}' and v.version_no = 1`)).toBe("3");
    expect(q(`select count(*) from public.campaign_contacts cc join public.campaign_message_versions v on v.id = cc.message_version_id where cc.campaign_id = '${c.id}' and v.version_no = 2`)).toBe("5");
    expect(q(`select body from public.campaign_message_versions where campaign_id = '${c.id}' and version_no = 1`)).toMatch(/^Oi /);

    expect(erro(`update public.campaign_message_versions set body = 'reescrevendo o passado' where campaign_id = '${c.id}' and version_no = 1`)).toMatch(/campaign_version_immutable/);
    expect(erro(`update public.campaign_message_versions set version_no = 9 where campaign_id = '${c.id}' and version_no = 1`)).toMatch(/campaign_version_immutable/);
    expect(q(`select superseded_at is not null from public.campaign_message_versions where campaign_id = '${c.id}' and version_no = 1`)).toBe("t");
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'version_activated'`)).toBe("2");
  });

  it("editar em cima de versão desatualizada é recusado, e salvar sem ativar não muda o envio", () => {
    const c = montar({ contatos: 4 });
    sql(`select public.fn_campaign_create_version('${ORG}', '${c.id}', 'Segunda', '${GOV_ADMIN}', true, 1)`);
    // A tela ainda achava que a última era a V1.
    expect(erro(`select public.fn_campaign_create_version('${ORG}', '${c.id}', 'Terceira', '${GOV_ADMIN}', true, 1)`)).toMatch(/campaign_version_conflict/);
    // Guardar a V3 SEM aplicar aos próximos.
    const v3 = json<{ version_no: number; activated: boolean }>(
      `select public.fn_campaign_create_version('${ORG}', '${c.id}', 'Terceira guardada', '${GOV_ADMIN}', false, 2)::text`,
    );
    expect(v3).toMatchObject({ version_no: 3, activated: false });
    const [d] = enviar(c.id, CH_A, 1);
    expect(d).toMatchObject({ decision: "send", version_no: 2 });
    expect(q(`select activated_at is null from public.campaign_message_versions where campaign_id = '${c.id}' and version_no = 3`)).toBe("t");
  });

  it("trocar o destino vale só para os próximos, fecha o anterior e guarda o histórico", () => {
    const c = montar({ contatos: 8 });
    const antes = enviar(c.id, CH_A, 3);
    expect(antes.every((d) => d.destination_id === c.destino1 && d.destination_url === "https://chat.whatsapp.com/AAAA1111")).toBe(true);

    const troca = json<{ changed: boolean; destination_id: string; switch: { changed: boolean } }>(
      `select public.fn_campaign_add_destination('${ORG}', '${c.id}', 'BLACK #02', 'https://chat.whatsapp.com/BBBB2222', null, 950, '${GOV_ADMIN}', true, '${c.destino1}', 'full')::text`,
    );
    expect(troca.switch.changed).toBe(true);
    const depois = enviar(c.id, CH_A, 5);
    expect(depois.every((d) => d.destination_id === troca.destination_id && d.destination_url === "https://chat.whatsapp.com/BBBB2222")).toBe(true);

    expect(q(`select count(*) from public.campaign_contacts where campaign_id = '${c.id}' and destination_id = '${c.destino1}'`)).toBe("3");
    expect(q(`select count(*) from public.campaign_contacts where campaign_id = '${c.id}' and destination_id = '${troca.destination_id}'`)).toBe("5");
    expect(q(`select status || '/' || close_reason from public.campaign_destinations where id = '${c.destino1}'`)).toBe("closed/full");
    expect(q(`select status from public.campaign_destinations where id = '${troca.destination_id}'`)).toBe("active");
    expect(q(`select count(*) from public.campaign_destinations where campaign_id = '${c.id}' and status = 'active'`)).toBe("1");
    // O momento exato da troca fica registrado, com de-para.
    // Duas trocas na trilha: a ativação inicial (nada -> #01) e a troca (#01 -> #02), cada uma com o seu instante.
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'destination_changed' and occurred_at is not null`)).toBe("2");
    expect(q(`select payload->>'from_name' || ' -> ' || (payload->>'to_name') from public.campaign_events where campaign_id = '${c.id}' and kind = 'destination_changed' and payload->>'from_name' is not null`)).toBe("BLACK #01 -> BLACK #02");
  });

  it("trocar para o destino que já é o ativo não faz nada; expectativa desatualizada é recusada; destino fechado não reabre", () => {
    const c = montar({ contatos: 2 });
    expect(json(`select public.fn_campaign_switch_destination('${ORG}', '${c.id}', '${c.destino1}')::text`)).toMatchObject({ changed: false });
    const n2 = json<{ destination_id: string }>(
      `select public.fn_campaign_add_destination('${ORG}', '${c.id}', 'BLACK #02', 'https://chat.whatsapp.com/BBBB2222', null, null, '${GOV_ADMIN}', true, null)::text`,
    ).destination_id;
    // Outra pessoa trocou primeiro: a tela ainda achava que o ativo era o #01.
    expect(erro(`select public.fn_campaign_switch_destination('${ORG}', '${c.id}', '${c.destino1}', null, 'full', '${c.destino1}')`)).toMatch(/campaign_destination_conflict/);
    expect(erro(`select public.fn_campaign_switch_destination('${ORG}', '${c.id}', '${c.destino1}', null, 'full', '${n2}')`)).toMatch(/campaign_destination_closed/);
  });

  it("mensagem com {{link_grupo}} sem destino ativo não envia: devolve o contato à fila", () => {
    const c = montar({ contatos: 2 });
    sql(`update public.campaigns set active_destination_id = null where id = '${c.id}'`);
    const [r] = reservar(c.id, CH_A, 1);
    expect(iniciarEnvio(r!)).toMatchObject({ decision: "no_destination" });
    expect(contagens(c.id)).toMatchObject({ pending: 2, sent: 0 });
  });
});

// ── worker que morre, reserva perdida, evento repetido ──────────────────────

describe("Central de Disparos — nada é enviado em dobro", () => {
  it("dois workers no mesmo contato: um envia, o outro descobre que perdeu", () => {
    const c = montar({ contatos: 2 });
    const [r] = reservar(c.id, CH_A, 1);
    expect(iniciarEnvio(r!).decision).toBe("send");
    expect(iniciarEnvio(r!).decision).toBe("already_processing"); // mesmo token, segunda vez
    expect(iniciarEnvio({ id: r!.id, token: "00000000-0000-4000-8000-000000000000" }).decision).toBe("lost");
    expect(concluir({ id: r!.id, token: "00000000-0000-4000-8000-000000000000" })).toBe("lost");
    expect(concluir(r!)).toBe("ok");
    expect(concluir(r!)).toBe("already"); // evento repetido não duplica
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'sent'`)).toBe("1");
    expect(q(`select attempts from public.campaign_contacts where id = '${r!.id}'`)).toBe("1");
  });

  it("reservado e abandonado volta para a fila; em envio e abandonado fica INCERTO, nunca reenvia", () => {
    const c = montar({ contatos: 4 });
    const [reservado, emEnvio] = reservar(c.id, CH_A, 2) as [Reserva, Reserva];
    expect(iniciarEnvio(emEnvio).decision).toBe("send");
    sql(`update public.campaign_contacts set lease_expires_at = now() - interval '5 minutes' where id in ('${reservado.id}', '${emEnvio.id}')`);

    // O varredor é GLOBAL (todas as organizações e campanhas): a contagem pode incluir lease vencida de outro teste.
    const varredura = json<{ released: number; uncertain: number }>(`select public.fn_campaign_sweep_leases()::text`);
    expect(varredura.released).toBeGreaterThanOrEqual(1);
    expect(varredura.uncertain).toBeGreaterThanOrEqual(1);
    expect(q(`select status from public.campaign_contacts where id = '${reservado.id}'`)).toBe("pending");
    expect(q(`select status from public.campaign_contacts where id = '${emEnvio.id}'`)).toBe("uncertain");
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'uncertain'`)).toBe("1");
    // Varrer de novo é inofensivo.
    expect(json(`select public.fn_campaign_sweep_leases()::text`)).toMatchObject({ released: 0, uncertain: 0 });

    // O incerto NUNCA entra de volta na fila, mesmo drenando tudo.
    enviar(c.id, CH_A, 50);
    expect(q(`select status from public.campaign_contacts where id = '${emEnvio.id}'`)).toBe("uncertain");
    expect(q(`select attempts from public.campaign_contacts where id = '${emEnvio.id}'`)).toBe("1");
    // Se o worker "morto" terminar depois, a mensagem existe: incerto vira enviado.
    expect(concluir(emEnvio)).toBe("ok");
    expect(q(`select status from public.campaign_contacts where id = '${emEnvio.id}'`)).toBe("sent");
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and campaign_contact_id = '${emEnvio.id}' and kind = 'sent'`)).toBe("1");
  });

  it("falha certa reagenda com espera e respeita o teto de tentativas; falha ambígua vira incerta", () => {
    const c = montar({ contatos: 3 });
    const [a] = reservar(c.id, CH_A, 1) as [Reserva];
    expect(iniciarEnvio(a).decision).toBe("send");
    expect(q(`select public.fn_campaign_mark_failed('${ORG}', '${a.id}', '${a.token}', 'session_down', 'sessão fora', true, 2)`)).toBe("retry");
    expect(q(`select status || '/' || (next_attempt_at > now())::text from public.campaign_contacts where id = '${a.id}'`)).toBe("pending/true");

    // Em espera: não é reservado de novo até vencer.
    const outros = reservar(c.id, CH_A, 10);
    expect(outros).toHaveLength(2);
    expect(outros.map((r) => r.id)).not.toContain(a.id);

    // Venceu a espera: volta, é a 2ª tentativa e, com o teto em 2, a falha passa a ser definitiva.
    sql(`update public.campaign_contacts set next_attempt_at = now() - interval '1 second' where id = '${a.id}'`);
    const [a2] = reservar(c.id, CH_A, 10) as [Reserva];
    expect(a2.id).toBe(a.id);
    expect(iniciarEnvio(a2).decision).toBe("send");
    expect(q(`select attempts from public.campaign_contacts where id = '${a.id}'`)).toBe("2");
    expect(q(`select public.fn_campaign_mark_failed('${ORG}', '${a2.id}', '${a2.token}', 'session_down', 'de novo', true, 2)`)).toBe("failed");

    // Falha ambígua (o WAHA pode ter aceitado): fica incerta para uma pessoa decidir.
    const amb = outros[0]!;
    expect(iniciarEnvio(amb).decision).toBe("send");
    expect(q(`select public.fn_campaign_mark_uncertain('${ORG}', '${amb.id}', '${amb.token}', 'timeout', 'sem resposta')`)).toBe("ok");
    expect(q(`select status from public.campaign_contacts where id = '${amb.id}'`)).toBe("uncertain");
  });

  it("falha definitiva vira `failed`, registra o motivo e não volta para a fila", () => {
    const c = montar({ contatos: 2 });
    const [a] = reservar(c.id, CH_A, 1) as [Reserva];
    iniciarEnvio(a);
    expect(q(`select public.fn_campaign_mark_failed('${ORG}', '${a.id}', '${a.token}', 'invalid_number', 'número inválido', false)`)).toBe("failed");
    expect(q(`select status || '/' || last_error_code from public.campaign_contacts where id = '${a.id}'`)).toBe("failed/invalid_number");
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'send_failed'`)).toBe("1");
    expect(enviar(c.id, CH_A, 10)).toHaveLength(1);
  });

  it("dois números na mesma campanha não pegam o mesmo contato", () => {
    const c = montar({ contatos: 9, canais: [CH_A, CH_B] });
    const a = reservar(c.id, CH_A, 5).map((r) => r.id);
    const b = reservar(c.id, CH_B, 5).map((r) => r.id);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(4);
    expect(new Set([...a, ...b]).size).toBe(9);
    expect(q(`select count(*) from public.campaign_contacts where campaign_id = '${c.id}' and channel_session_id = '${CH_B}'`)).toBe("4");
  });
});

// ── canal e contato ─────────────────────────────────────────────────────────

describe("Central de Disparos — canal caído e contato que não pode receber", () => {
  it("canal desconectado não reserva; reservado e desconectado depois devolve o contato à fila", () => {
    const c = montar({ contatos: 4, canais: [CH_A, CH_B] });
    const [r] = reservar(c.id, CH_A, 1) as [Reserva];
    sql(`update public.channel_sessions set status = 'STOPPED' where id = '${CH_A}'`);
    try {
      expect(reservar(c.id, CH_A, 3)).toHaveLength(0);
      expect(iniciarEnvio(r)).toMatchObject({ decision: "channel_unavailable" });
      expect(q(`select status from public.campaign_contacts where id = '${r.id}'`)).toBe("pending");
      // O outro número segue e a fila continua inteira.
      expect(enviar(c.id, CH_B, 10).every((d) => d.decision === "send")).toBe(true);
      expect(contagens(c.id)).toMatchObject({ sent: 4, pending: 0 });
    } finally {
      sql(`update public.channel_sessions set status = 'WORKING' where id = '${CH_A}'`);
    }
  });

  it("número tirado da campanha deixa de receber reservas", () => {
    const c = montar({ contatos: 4, canais: [CH_A, CH_B] });
    sql(`select public.fn_campaign_set_channels('${ORG}', '${c.id}', array['${CH_B}'::uuid])`);
    expect(reservar(c.id, CH_A, 2)).toHaveLength(0);
    expect(reservar(c.id, CH_B, 2)).toHaveLength(2);
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'channel_removed'`)).toBe("1");
  });

  it("bloqueado, que recusou marketing, sem telefone ou anonimizado NUNCA é enviado", () => {
    const c = montar({ contatos: 6 });
    sql(`
      with alvo as (select cc.contact_id, row_number() over (order by cc.seq) n from public.campaign_contacts cc where cc.campaign_id = '${c.id}')
      update public.contacts k set
        is_blocked = (alvo.n = 1),
        consent = case when alvo.n = 2 then jsonb_build_object('marketing', jsonb_build_object('declined_at', now()::text)) else k.consent end,
        phone_number = case when alvo.n = 3 then null else k.phone_number end
      from alvo where k.id = alvo.contact_id and alvo.n <= 3;
    `);
    const anon = q(`select contact_id from public.campaign_contacts where campaign_id = '${c.id}' order by seq offset 3 limit 1`);
    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${anon}'`);

    const decisoes = enviar(c.id, CH_A, 20);
    expect(decisoes.filter((d) => d.decision === "send")).toHaveLength(2);
    const motivos = decisoes.filter((d) => d.decision === "skipped").map((d) => d.reason).sort();
    expect(motivos).toEqual(["anonymized", "blocked", "declined_marketing", "no_phone"]);
    expect(contagens(c.id)).toMatchObject({ sent: 2, skipped: 4, pending: 0 });
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and kind = 'skipped'`)).toBe("4");
  });
});

// ── trilha, LGPD e regras da linha ──────────────────────────────────────────

describe("Central de Disparos — trilha, LGPD e regras da linha", () => {
  it("a linha do tempo do contato diz qual número, versão e destino valiam quando ele recebeu", () => {
    const c = montar({ contatos: 3 });
    const [r] = reservar(c.id, CH_A, 1) as [Reserva];
    iniciarEnvio(r);
    concluir(r);
    expect(
      q(`select (e.channel_session_id = '${CH_A}')::text || '/' || (v.version_no = 1)::text || '/' || (e.destination_id = '${c.destino1}')::text
           from public.campaign_events e join public.campaign_message_versions v on v.id = e.message_version_id
          where e.campaign_contact_id = '${r.id}' and e.kind = 'sent'`),
    ).toBe("true/true/true");
    expect(q(`select length(tracking_token) from public.campaign_contacts where id = '${r.id}'`)).toBe("20");
    expect(q(`select count(distinct tracking_token) from public.campaign_contacts where campaign_id = '${c.id}'`)).toBe("3");
  });

  it("anonimizar o contato zera o que veio do CSV, mas o histórico do envio fica", () => {
    const c = montar({ contatos: 2 });
    const [r] = reservar(c.id, CH_A, 1) as [Reserva];
    iniciarEnvio(r);
    concluir(r);
    sql(`update public.campaign_contacts set variables = '{"produto":"Tênis","cidade":"Campinas"}'::jsonb where id = '${r.id}'`);
    const contato = q(`select contact_id from public.campaign_contacts where id = '${r.id}'`);
    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${contato}'`);
    expect(q(`select variables::text from public.campaign_contacts where id = '${r.id}'`)).toBe("{}");
    expect(q(`select status from public.campaign_contacts where id = '${r.id}'`)).toBe("sent");
    expect(q(`select count(*) from public.campaign_events where campaign_contact_id = '${r.id}' and kind = 'sent'`)).toBe("1");
  });

  it("a linha recusa o que a máquina de estados não permite", () => {
    const c = montar({ contatos: 2, iniciar: false });
    const linha = q(`select id from public.campaign_contacts where campaign_id = '${c.id}' limit 1`);
    // Reservado sem dono/prazo.
    expect(erro(`update public.campaign_contacts set status = 'queued' where id = '${linha}'`)).toMatch(/check constraint/);
    // Enviado sem carimbo de envio.
    expect(erro(`update public.campaign_contacts set status = 'sent' where id = '${linha}'`)).toMatch(/check constraint/);
    // Ignorado sem motivo.
    expect(erro(`update public.campaign_contacts set status = 'skipped' where id = '${linha}'`)).toMatch(/check constraint/);
    // A mesma pessoa duas vezes na mesma campanha.
    expect(erro(`insert into public.campaign_contacts (organization_id, campaign_id, contact_id) select organization_id, campaign_id, contact_id from public.campaign_contacts where id = '${linha}'`)).toMatch(/duplicate key/);
    // Estado inventado.
    expect(erro(`update public.campaigns set status = 'bombando' where id = '${c.id}'`)).toMatch(/check constraint/);
    // Link que não é https.
    expect(erro(`select public.fn_campaign_add_destination('${ORG}', '${c.id}', 'x', 'javascript:alert(1)')`)).toMatch(/check constraint/);
    expect(erro(`select public.fn_campaign_add_destination('${ORG}', '${c.id}', 'x', 'http://chat.whatsapp.com/abc')`)).toMatch(/check constraint/);
  });

  it("um evento repetido com a mesma chave não vira duas linhas", () => {
    const c = montar({ contatos: 1, iniciar: false });
    sql(`
      select public.fn_campaign_log('${ORG}', '${c.id}', 'imported', null, null, null, null, null, '{"rows":1}'::jsonb, 'imp:1');
      select public.fn_campaign_log('${ORG}', '${c.id}', 'imported', null, null, null, null, null, '{"rows":1}'::jsonb, 'imp:1');
    `);
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}' and idempotency_key = 'imp:1'`)).toBe("1");
  });

  it("toda mudança de configuração é registrada com antes/depois", () => {
    const c = montar({ contatos: 1, iniciar: false });
    expect(json(`select public.fn_campaign_update_settings('${ORG}', '${c.id}', '${GOV_ADMIN}', 'Novo nome', false, 'pause_campaign')::text`)).toMatchObject({ changed: true });
    expect(json(`select public.fn_campaign_update_settings('${ORG}', '${c.id}', '${GOV_ADMIN}', 'Novo nome', false, 'pause_campaign')::text`)).toMatchObject({ changed: false });
    expect(q(`select payload->'tracking_enabled'->>'from' || '>' || (payload->'tracking_enabled'->>'to') from public.campaign_events where campaign_id = '${c.id}' and kind = 'settings_changed'`)).toBe("true>false");
  });

  it("campanha rascunho pode ser removida inteira; a trilha some junto (cascade do dono)", () => {
    const c = montar({ contatos: 2, iniciar: false });
    sql(`delete from public.campaigns where id = '${c.id}'`);
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c.id}'`)).toBe("0");
    expect(q(`select count(*) from public.campaign_contacts where campaign_id = '${c.id}'`)).toBe("0");
  });
});
