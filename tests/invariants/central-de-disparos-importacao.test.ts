import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — IMPORTAÇÃO DE CSV (migration 0281).
 *
 * Prova, no banco que o self-hoster recebe, o que a importação promete:
 *
 *   - a prévia conta certo ANTES de importar (válidos, repetidos, já na campanha);
 *   - importar em lotes, repetir um lote ou "voltar depois de fechar a aba" nunca duplica
 *     contato nem coloca a pessoa duas vezes na campanha;
 *   - quem já é contato é reaproveitado (inclusive pela variante com/sem o nono dígito);
 *   - e-mail repetido não derruba o lote;
 *   - importar NÃO emite `contact.created` (não acorda automação, IA nem push);
 *   - a linha importada perde o dado pessoal cru; desistir e a faxina apagam o resto;
 *   - a staging não é lida pelo navegador nem alcançada por outra organização.
 *
 * Aqui o veredito de telefone (regra de servidor, em TypeScript) é montado à mão: o que
 * se prova é a parte do BANCO. A regra de telefone tem teste próprio em
 * `tests/unit/campanhas-importacao.test.ts`.
 */

const ORG = GOV_ORG;
const ORG_B = "dddddddd-0000-4000-8000-00000000000b";
const CH_A = "dddddddd-2222-4000-8000-00000000000a";

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

let base = 200_000_000 + Math.floor(Math.random() * 600_000_000);
/** Telefone brasileiro de 11 dígitos único por chamada: +55 11 9 XXXX-XXXX. */
const novoTelefone = () => `+55119${String(++base).padStart(8, "0").slice(-8)}`;
/** A contraparte sem o nono dígito (12 dígitos), que é como algumas linhas antigas guardam. */
const semNono = (tel: string) => tel.replace("+55119", "+5511");

interface Veredito {
  n: number;
  status: "valid" | "rejected";
  reason?: string;
  name?: string;
  phone?: string;
  variants?: string[];
  email?: string | null;
  extras?: Record<string, string>;
}
const valida = (n: number, phone: string, extra: Partial<Veredito> = {}): Veredito => ({
  n,
  status: "valid",
  phone,
  variants: [phone, semNono(phone)],
  name: `Pessoa ${n}`,
  extras: { produto: `Produto ${n}` },
  ...extra,
});
const rejeita = (n: number, reason: string): Veredito => ({ n, status: "rejected", reason });

const literal = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'disp-b', 'Disparos B', 'Disparos B') on conflict do nothing;
    do $f$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
        values ('${CH_A}', '${ORG}', 'disp-a', '\\x00'::bytea, 'WORKING');
    exception when unique_violation then null; end $f$;
  `);
});

function campanha(): string {
  return q(`select public.fn_campaign_create('${ORG}', 'Import ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
}

/** Cria a importação e grava as linhas cruas (n = 1..total). */
function subir(camp: string, total: number): string {
  const id = q(`select public.fn_campaign_import_create('${ORG}', '${camp}', '${GOV_ADMIN}', 'lista.csv', '["Nome","Telefone","E-mail","Produto"]'::jsonb, ${total})`);
  const linhas = Array.from({ length: total }, (_, i) => ({ n: i + 1, cells: [`Pessoa ${i + 1}`, "x", "", "p"] }));
  sql(`select public.fn_campaign_import_stage_raw('${ORG}', '${id}', ${literal(linhas)})`);
  return id;
}
const aplicar = (imp: string, v: Veredito[]) =>
  sql(`select public.fn_campaign_import_apply('${ORG}', '${imp}', ${literal(v)})`);
const fechar = (imp: string) =>
  json<Resumo>(`select public.fn_campaign_import_finish_validation('${ORG}', '${imp}', '{"phone":1}'::jsonb)::text`);
const commit = (imp: string, limite: number) =>
  json<{ processed: number; remaining: number; status: string }>(
    `select public.fn_campaign_import_commit('${ORG}', '${imp}', '${GOV_ADMIN}', ${limite})::text`,
  );
const contagem = (sqlText: string) => Number(q(sqlText));

interface Resumo {
  found: number;
  raw: number;
  valid: number;
  imported: number;
  rejected: number;
  existing_contacts: number;
  new_contacts: number;
  by_reason: Record<string, number>;
  status: string;
}

describe("Central de Disparos — importação: a prévia conta antes de importar", () => {
  it("grava as linhas cruas sem duplicar quando o lote é repetido", () => {
    const camp = campanha();
    const imp = q(`select public.fn_campaign_import_create('${ORG}', '${camp}', '${GOV_ADMIN}', 'a.csv', '["Nome","Telefone"]'::jsonb, 3)`);
    const lote = literal([1, 2, 3].map((n) => ({ n, cells: [`P${n}`, "1"] })));
    expect(q(`select public.fn_campaign_import_stage_raw('${ORG}', '${imp}', ${lote})`)).toBe("3");
    expect(q(`select public.fn_campaign_import_stage_raw('${ORG}', '${imp}', ${lote})`)).toBe("0");
    expect(contagem(`select count(*) from public.campaign_import_rows where import_id = '${imp}'`)).toBe(3);
    expect(json<Resumo>(`select public.fn_campaign_import_summary('${ORG}', '${imp}')::text`)).toMatchObject({ found: 3, raw: 3, status: "uploaded" });
  });

  it("classifica válidos, repetidos no arquivo, já-contatos e quem já está na campanha", () => {
    const camp = campanha();
    const [t1, t2, t3, t4, t5] = [novoTelefone(), novoTelefone(), novoTelefone(), novoTelefone(), novoTelefone()] as [string, string, string, string, string];
    // t3 já é contato; t4 já é contato guardado SEM o nono dígito; t5 já é contato E já está nesta campanha.
    sql(`
      insert into public.contacts (organization_id, display_name, phone_number)
        values ('${ORG}', 'Ja existe 3', '${t3}'), ('${ORG}', 'Ja existe 4', '${semNono(t4)}'), ('${ORG}', 'Ja existe 5', '${t5}');
      insert into public.campaign_contacts (organization_id, campaign_id, contact_id)
        select '${ORG}', '${camp}', id from public.contacts where organization_id = '${ORG}' and phone_number = '${t5}';
    `);
    const imp = subir(camp, 7);
    aplicar(imp, [
      valida(1, t1),
      valida(2, t2),
      rejeita(3, "invalid_phone"),
      valida(4, t1), // o mesmo telefone da linha 1
      valida(5, t3),
      valida(6, t4),
      valida(7, t5),
    ]);
    const r = fechar(imp);
    expect(r).toMatchObject({ found: 7, valid: 4, rejected: 3, imported: 0, existing_contacts: 2, new_contacts: 2, status: "validated" });
    expect(r.by_reason).toEqual({ invalid_phone: 1, duplicate_in_file: 1, already_in_campaign: 1 });
    // A LINHA 1 fica com a primeira ocorrência; a 4 é a repetida.
    expect(q(`select status || '/' || coalesce(reason, '-') from public.campaign_import_rows where import_id = '${imp}' and line_no = 4`)).toBe("rejected/duplicate_in_file");
    expect(q(`select status from public.campaign_import_rows where import_id = '${imp}' and line_no = 1`)).toBe("valid");
    // Prévia não cria nada.
    expect(contagem(`select count(*) from public.campaign_contacts where import_id = '${imp}'`)).toBe(0);
  });

  it("dois telefones equivalentes que resolvem para o MESMO contato contam como repetição", () => {
    const camp = campanha();
    const tel = novoTelefone();
    sql(`insert into public.contacts (organization_id, display_name, phone_number) values ('${ORG}', 'Mesmo', '${tel}')`);
    const imp = subir(camp, 2);
    aplicar(imp, [valida(1, tel), valida(2, semNono(tel), { variants: [semNono(tel), tel] })]);
    const r = fechar(imp);
    expect(r).toMatchObject({ valid: 1, rejected: 1, by_reason: { duplicate_in_file: 1 } });
  });

  it("revalidar com outro mapeamento sobrescreve o veredito enquanto nada foi importado", () => {
    const camp = campanha();
    const imp = subir(camp, 2);
    aplicar(imp, [rejeita(1, "empty_phone"), rejeita(2, "empty_phone")]);
    expect(fechar(imp)).toMatchObject({ valid: 0, rejected: 2 });
    aplicar(imp, [valida(1, novoTelefone()), valida(2, novoTelefone())]);
    expect(fechar(imp)).toMatchObject({ valid: 2, rejected: 0 });
  });

  it("não fecha a validação com linhas ainda não validadas", () => {
    const camp = campanha();
    const imp = subir(camp, 3);
    aplicar(imp, [valida(1, novoTelefone())]); // faltam a 2 e a 3
    expect(erro(`select public.fn_campaign_import_finish_validation('${ORG}', '${imp}', '{"phone":1}'::jsonb)`)).toMatch(/campaign_import_not_validated/);
    expect(erro(`select public.fn_campaign_import_commit('${ORG}', '${imp}', '${GOV_ADMIN}', 10)`)).toMatch(/campaign_import_not_validated/);
  });
});

describe("Central de Disparos — importação em lotes, retomável e sem duplicar", () => {
  it("importa por lotes, reaproveita contato existente e a segunda passada não faz nada", () => {
    const camp = campanha();
    const [t1, t2, t3, t4] = [novoTelefone(), novoTelefone(), novoTelefone(), novoTelefone()] as [string, string, string, string];
    sql(`insert into public.contacts (organization_id, display_name, phone_number) values ('${ORG}', 'Antigo', '${semNono(t3)}')`);
    const eventosAntes = contagem(`select count(*) from public.event_log where event_type = 'contact.created' and organization_id = '${ORG}'`);
    const contatosAntes = contagem(`select count(*) from public.contacts where organization_id = '${ORG}'`);

    const imp = subir(camp, 4);
    aplicar(imp, [valida(1, t1), valida(2, t2), valida(3, t3), valida(4, t4)]);
    fechar(imp);

    expect(commit(imp, 3)).toMatchObject({ processed: 3, remaining: 1, status: "importing" });
    // "Fechou a aba, voltou depois": a mesma chamada continua do ponto exato.
    expect(commit(imp, 3)).toMatchObject({ processed: 1, remaining: 0, status: "done" });
    expect(commit(imp, 3)).toMatchObject({ processed: 0, remaining: 0, status: "done" });

    expect(contagem(`select count(*) from public.campaign_contacts where campaign_id = '${camp}'`)).toBe(4);
    expect(contagem(`select count(distinct contact_id) from public.campaign_contacts where campaign_id = '${camp}'`)).toBe(4);
    // 3 contatos NOVOS; o quarto é o que já existia (achado pela variante sem o nono dígito).
    expect(contagem(`select count(*) from public.contacts where organization_id = '${ORG}'`)).toBe(contatosAntes + 3);
    expect(contagem(`select count(*) from public.contacts where organization_id = '${ORG}' and source = 'campaign_import'`)).toBeGreaterThanOrEqual(3);
    expect(q(`select count(*) from public.contacts where organization_id = '${ORG}' and phone_number in ('${t3}', '${semNono(t3)}')`)).toBe("1");
    // Importar 45 mil pessoas não acorda automação, IA nem push.
    expect(contagem(`select count(*) from public.event_log where event_type = 'contact.created' and organization_id = '${ORG}'`)).toBe(eventosAntes);
    // A trilha registra a importação UMA vez, com o resultado.
    expect(contagem(`select count(*) from public.campaign_events where campaign_id = '${camp}' and kind = 'imported'`)).toBe(1);
    expect(q(`select payload->>'imported' from public.campaign_events where campaign_id = '${camp}' and kind = 'imported'`)).toBe("4");
  });

  it("guarda de onde veio cada pessoa e as colunas extras viram variáveis da linha", () => {
    const camp = campanha();
    const t = novoTelefone();
    const imp = subir(camp, 1);
    aplicar(imp, [valida(1, t, { extras: { produto: "Tênis", cidade: "Campinas" } })]);
    fechar(imp);
    commit(imp, 10);
    expect(q(`select import_line_no from public.campaign_contacts where campaign_id = '${camp}'`)).toBe("1");
    expect(q(`select variables->>'produto' || '/' || (variables->>'cidade') from public.campaign_contacts where campaign_id = '${camp}'`)).toBe("Tênis/Campinas");
    expect(q(`select status from public.campaign_contacts where campaign_id = '${camp}'`)).toBe("pending");
    expect(q(`select import_id = '${imp}' from public.campaign_contacts where campaign_id = '${camp}'`)).toBe("t");
  });

  it("depois de importar, a linha perde o dado pessoal cru; as rejeitadas ficam para baixar", () => {
    const camp = campanha();
    const imp = subir(camp, 2);
    aplicar(imp, [valida(1, novoTelefone()), rejeita(2, "invalid_phone")]);
    fechar(imp);
    commit(imp, 10);
    expect(q(`select coalesce(name, '') || coalesce(phone, '') || coalesce(email, '') || coalesce(cells::text, '') || coalesce(extras::text, '') from public.campaign_import_rows where import_id = '${imp}' and line_no = 1`)).toBe("");
    expect(q(`select status from public.campaign_import_rows where import_id = '${imp}' and line_no = 1`)).toBe("imported");
    expect(q(`select cells is not null from public.campaign_import_rows where import_id = '${imp}' and line_no = 2`)).toBe("t");
  });

  it("e-mail repetido (no lote ou de outro contato) não derruba o lote: o e-mail é dispensado", () => {
    const camp = campanha();
    const email = `dup-${Math.random().toString(36).slice(2, 8)}@invariant.test`;
    const emailDoOutro = `outro-${Math.random().toString(36).slice(2, 8)}@invariant.test`;
    sql(`insert into public.contacts (organization_id, display_name, phone_number, email) values ('${ORG}', 'Dono do email', '${novoTelefone()}', '${emailDoOutro}')`);
    const imp = subir(camp, 3);
    aplicar(imp, [
      valida(1, novoTelefone(), { email }),
      valida(2, novoTelefone(), { email }), // mesmo e-mail que a linha 1
      valida(3, novoTelefone(), { email: emailDoOutro }), // e-mail que já é de outro contato
    ]);
    fechar(imp);
    expect(commit(imp, 10)).toMatchObject({ processed: 3, remaining: 0, status: "done" });
    expect(contagem(`select count(*) from public.campaign_contacts where campaign_id = '${camp}'`)).toBe(3);
    expect(q(`select count(*) from public.contacts where organization_id = '${ORG}' and lower(email) = lower('${email}')`)).toBe("1");
    expect(q(`select count(*) from public.contacts where organization_id = '${ORG}' and lower(email) = lower('${emailDoOutro}')`)).toBe("1");
  });

  it("acrescenta gente a uma campanha que já está rodando: entram no FIM da fila", () => {
    const camp = campanha();
    sql(`
      select public.fn_campaign_create_version('${ORG}', '${camp}', 'Oi {{nome}}', '${GOV_ADMIN}');
      select public.fn_campaign_set_channels('${ORG}', '${camp}', array['${CH_A}'::uuid]);
    `);
    const primeira = subir(camp, 1);
    aplicar(primeira, [valida(1, novoTelefone())]);
    fechar(primeira);
    commit(primeira, 10);
    sql(`select public.fn_campaign_transition('${ORG}', '${camp}', 'start', '${GOV_ADMIN}')`);
    const segunda = subir(camp, 1);
    aplicar(segunda, [valida(1, novoTelefone())]);
    fechar(segunda);
    commit(segunda, 10);
    expect(contagem(`select count(*) from public.campaign_contacts where campaign_id = '${camp}' and status = 'pending'`)).toBe(2);
    expect(q(`select (select seq from public.campaign_contacts where import_id = '${segunda}') > (select seq from public.campaign_contacts where import_id = '${primeira}')`)).toBe("t");
  });

  it("campanha encerrada não aceita importação nem lote", () => {
    const camp = campanha();
    const imp = subir(camp, 1);
    aplicar(imp, [valida(1, novoTelefone())]);
    fechar(imp);
    sql(`select public.fn_campaign_transition('${ORG}', '${camp}', 'cancel', '${GOV_ADMIN}')`);
    expect(erro(`select public.fn_campaign_import_commit('${ORG}', '${imp}', '${GOV_ADMIN}', 10)`)).toMatch(/campaign_closed/);
    expect(erro(`select public.fn_campaign_import_create('${ORG}', '${camp}', '${GOV_ADMIN}', 'x.csv', '[]'::jsonb, 0)`)).toMatch(/campaign_closed/);
  });

  it("depois que a importação começou, a validação e o upload ficam travados", () => {
    const camp = campanha();
    const imp = subir(camp, 2);
    aplicar(imp, [valida(1, novoTelefone()), valida(2, novoTelefone())]);
    fechar(imp);
    commit(imp, 1);
    expect(erro(`select public.fn_campaign_import_apply('${ORG}', '${imp}', ${literal([valida(1, novoTelefone())])})`)).toMatch(/campaign_import_locked/);
    expect(erro(`select public.fn_campaign_import_stage_raw('${ORG}', '${imp}', ${literal([{ n: 9, cells: ["x"] }])})`)).toMatch(/campaign_import_locked/);
  });
});

describe("Central de Disparos — desistir, faxina e isolamento", () => {
  it("desistir apaga o que ainda é dado cru e não cria contato nenhum", () => {
    const camp = campanha();
    const imp = subir(camp, 3);
    aplicar(imp, [valida(1, novoTelefone()), valida(2, novoTelefone()), rejeita(3, "empty_phone")]);
    fechar(imp);
    expect(json<{ changed: boolean; status: string; discarded_rows: number }>(`select public.fn_campaign_import_cancel('${ORG}', '${imp}')::text`)).toMatchObject({ changed: true, status: "cancelled", discarded_rows: 3 });
    expect(contagem(`select count(*) from public.campaign_import_rows where import_id = '${imp}'`)).toBe(0);
    expect(contagem(`select count(*) from public.campaign_contacts where campaign_id = '${camp}'`)).toBe(0);
    expect(json(`select public.fn_campaign_import_cancel('${ORG}', '${imp}')::text`)).toMatchObject({ changed: false });
  });

  it("a faxina apaga linha crua de importação velha e abandonada; a recente fica", () => {
    const camp = campanha();
    const velha = subir(camp, 2);
    const nova = subir(camp, 2);
    sql(`update public.campaign_imports set updated_at = now() - interval '40 days' where id = '${velha}'`);
    const r = json<{ abandoned_imports: number; deleted_rows: number }>(`select public.fn_campaign_import_purge(30)::text`);
    expect(r.abandoned_imports).toBeGreaterThanOrEqual(1);
    expect(contagem(`select count(*) from public.campaign_import_rows where import_id = '${velha}'`)).toBe(0);
    expect(q(`select status from public.campaign_imports where id = '${velha}'`)).toBe("cancelled");
    expect(contagem(`select count(*) from public.campaign_import_rows where import_id = '${nova}'`)).toBe(2);
  });

  it("a staging é só do servidor e uma organização não alcança a importação da outra", () => {
    for (const t of ["campaign_imports", "campaign_import_rows"]) {
      expect(q(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`)).toBe("t");
      for (const priv of ["select", "insert", "update", "delete"]) {
        expect(q(`select has_table_privilege('authenticated', 'public.${t}', '${priv}')`), `${t} ${priv}`).toBe("f");
        expect(q(`select has_table_privilege('anon', 'public.${t}', '${priv}')`), `anon ${t} ${priv}`).toBe("f");
      }
    }
    expect(
      q(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'fn_campaign_import%'
           and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))`),
    ).toBe("0");

    const camp = campanha();
    const imp = subir(camp, 1);
    expect(erro(`select public.fn_campaign_import_summary('${ORG_B}', '${imp}')`)).toMatch(/campaign_import_not_found/);
    expect(erro(`select public.fn_campaign_import_stage_raw('${ORG_B}', '${imp}', '[]'::jsonb)`)).toMatch(/campaign_import_not_found/);
    expect(erro(`select public.fn_campaign_import_commit('${ORG_B}', '${imp}')`)).toMatch(/campaign_import_not_found/);
    expect(erro(`select public.fn_campaign_import_cancel('${ORG_B}', '${imp}')`)).toMatch(/campaign_import_not_found/);
    expect(erro(`select public.fn_campaign_import_create('${ORG_B}', '${camp}', null, 'x.csv', '[]'::jsonb, 0)`)).toMatch(/campaign_not_found/);
  });

  it("a linha da staging recusa estado sem motivo e motivo sem estado", () => {
    const camp = campanha();
    const imp = subir(camp, 1);
    expect(erro(`update public.campaign_import_rows set status = 'rejected' where import_id = '${imp}'`)).toMatch(/check constraint/);
    expect(erro(`update public.campaign_import_rows set reason = 'invalid_phone' where import_id = '${imp}'`)).toMatch(/check constraint/);
    expect(erro(`update public.campaign_import_rows set reason = 'porque_sim', status = 'rejected' where import_id = '${imp}'`)).toMatch(/check constraint/);
  });
});
