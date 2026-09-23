import { beforeAll, describe, expect, it } from "vitest";

import { countAs, GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — "BLOQUEAR CONTATO" (migration 0287).
 *
 * Prova, contra o banco que o self-hoster recebe:
 *   - clicar no link bloqueia de verdade — e só PARA ESTA CAMPANHA (decisão do dono);
 *   - "tentar de novo" num incerto bloqueado NÃO volta a mandar mensagem pra ele;
 *   - "confirmar enviado"/"marcar falhou" (não reenviam) continuam funcionando igual, bloqueado ou não;
 *   - token errado nunca inventa bloqueio; clicar duas vezes é idempotente, um evento só.
 */

const ORG = GOV_ORG;
const q = (script: string): string => lastLine(sql(script));
let base = 900_000_000 + Math.floor(Math.random() * 90_000_000);
let seq = 0;

beforeAll(() => {
  seedGov();
});

interface Montagem {
  camp: string;
  canal: string;
  cc: string;
  token: string;
}

/** Uma campanha rodando com UM contato já ENVIADO. */
function enviado(): Montagem {
  const canal = q(`select gen_random_uuid()::text`);
  sql(`insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
         values ('${canal}', '${ORG}', 'bloq-${Date.now().toString(36)}-${++seq}', '\\x00'::bytea, 'WORKING')`);
  base += 1;
  const contato = q(`insert into public.contacts (organization_id, display_name, phone_number) values ('${ORG}', 'Bloq ${base}', '+5511${base}') returning id`);
  const camp = q(`select public.fn_campaign_create('${ORG}', 'Bloq ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
  sql(`
    select public.fn_campaign_create_version('${ORG}', '${camp}', 'Oi, {{nome}}! Não quer mais receber? {{bloquear}}', '${GOV_ADMIN}');
    select public.fn_campaign_set_channels('${ORG}', '${camp}', array['${canal}'::uuid], '${GOV_ADMIN}');
    insert into public.campaign_contacts (organization_id, campaign_id, contact_id) values ('${ORG}', '${camp}', '${contato}');
  `);
  sql(`select public.fn_campaign_add_destination('${ORG}', '${camp}', 'BLOQ #01', 'https://chat.whatsapp.com/BLOQ0001', null, 950, '${GOV_ADMIN}', true)`);
  sql(`select public.fn_campaign_transition('${ORG}', '${camp}', 'start', '${GOV_ADMIN}')`);
  const [linha] = sql(`select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${canal}', 1, 90, true)`).split("\n");
  const [cc, tk] = linha!.split("|") as [string, string];
  sql(`select public.fn_campaign_begin_send('${ORG}', '${cc}', '${tk}'); select public.fn_campaign_mark_sent('${ORG}', '${cc}', '${tk}', null, 'ext')`);
  const token = q(`select tracking_token from public.campaign_contacts where id = '${cc}'`);
  return { camp, canal, cc, token };
}

const bloquear = (token: string) => q(`select public.fn_campaign_block_contact('${token.replace(/'/g, "''")}')`);
const eventos = (cc: string) => Number(q(`select count(*) from public.campaign_events where campaign_contact_id = '${cc}' and kind = 'blocked'`));
const bloqueadoEm = (cc: string) => q(`select blocked_at is not null from public.campaign_contacts where id = '${cc}'`);

describe("Central de Disparos — bloquear contato (0287)", () => {
  it("clicar no link bloqueia de verdade, marca o carimbo e grava UM evento", () => {
    const m = enviado();
    expect(bloquear(m.token)).toBe("ok");
    expect(bloqueadoEm(m.cc)).toBe("t");
    expect(eventos(m.cc)).toBe(1);
    // status de ENTREGA não muda — bloqueio é engajamento, igual a clicked_at/replied_at.
    expect(q(`select status from public.campaign_contacts where id = '${m.cc}'`)).toBe("sent");
  });

  it("clicar duas vezes é idempotente: 'already' na segunda, sem duplicar o evento", () => {
    const m = enviado();
    expect(bloquear(m.token)).toBe("ok");
    expect(bloquear(m.token)).toBe("already");
    expect(eventos(m.cc)).toBe(1);
  });

  it("token errado nunca inventa bloqueio", () => {
    for (const ruim of ["", "abc", "'; drop table campaigns; --", "0".repeat(20)]) {
      expect(bloquear(ruim), ruim).toBe("unknown");
    }
  });

  it("'tentar de novo' num incerto BLOQUEADO não volta pra fila — devolve 'blocked'", () => {
    const m = enviado();
    // Um envio incerto de verdade: o worker não sabe se saiu, mas a pessoa recebeu e bloqueou.
    sql(`update public.campaign_contacts set status = 'uncertain' where id = '${m.cc}'`);
    expect(bloquear(m.token)).toBe("ok");
    expect(q(`select public.fn_campaign_resolve_uncertain('${ORG}', '${m.cc}', 'retry', '${GOV_ADMIN}')`)).toBe("blocked");
    // Continua 'uncertain': NÃO voltou a 'pending', não vai ser reenviado.
    expect(q(`select status from public.campaign_contacts where id = '${m.cc}'`)).toBe("uncertain");
  });

  it("'confirmar enviado' e 'marcar falhou' continuam funcionando num contato bloqueado — não reenviam", () => {
    const m1 = enviado();
    sql(`update public.campaign_contacts set status = 'uncertain' where id = '${m1.cc}'`);
    bloquear(m1.token);
    expect(q(`select public.fn_campaign_resolve_uncertain('${ORG}', '${m1.cc}', 'sent', '${GOV_ADMIN}')`)).toBe("ok");
    expect(q(`select status from public.campaign_contacts where id = '${m1.cc}'`)).toBe("sent");

    const m2 = enviado();
    sql(`update public.campaign_contacts set status = 'uncertain' where id = '${m2.cc}'`);
    bloquear(m2.token);
    expect(q(`select public.fn_campaign_resolve_uncertain('${ORG}', '${m2.cc}', 'failed', '${GOV_ADMIN}')`)).toBe("ok");
    expect(q(`select status from public.campaign_contacts where id = '${m2.cc}'`)).toBe("failed");
  });

  it("'tentar de novo' sem bloqueio continua igual a antes (não regrediu)", () => {
    const m = enviado();
    sql(`update public.campaign_contacts set status = 'uncertain' where id = '${m.cc}'`);
    expect(q(`select public.fn_campaign_resolve_uncertain('${ORG}', '${m.cc}', 'retry', '${GOV_ADMIN}')`)).toBe("ok");
    expect(q(`select status from public.campaign_contacts where id = '${m.cc}'`)).toBe("pending");
  });

  it("o bloqueio é isolado por organização; a função é só do servidor", () => {
    const m = enviado();
    bloquear(m.token);
    expect(countAs(GOV_ADMIN, `select count(*) from public.campaign_contacts where id = '${m.cc}' and blocked_at is not null`)).toBe(1);
    const outra = "dddddddd-1111-4000-8000-0000000000e1";
    sql(`insert into public.organizations (id, slug, legal_name, display_name) values ('dddddddd-0000-4000-8000-0000000000e1', 'bloq-b', 'Bloq B', 'Bloq B') on conflict do nothing;
         insert into auth.users (id, email) values ('${outra}', 'bloq-b@invariant.test') on conflict do nothing;
         insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${outra}', 'dddddddd-0000-4000-8000-0000000000e1', 'admin', now()) on conflict do nothing`);
    expect(countAs(outra, `select count(*) from public.campaign_contacts where id = '${m.cc}' and blocked_at is not null`)).toBe(0);
    for (const fn of ["fn_campaign_block_contact"]) {
      expect(q(`select has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("f");
      expect(q(`select has_function_privilege('service_role', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("t");
    }
  });
});
