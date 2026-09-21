import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * CENTRAL DE DISPAROS — DESPACHO (migration 0282).
 *
 * O que o banco garante ao despachante:
 *   - um contato em voo por número, de qualquer campanha: rodadas sobrepostas do cron não
 *     mandam duas mensagens ao mesmo tempo pelo mesmo número;
 *   - o incerto só se resolve por uma pessoa (enviado / tentar de novo / falhou), sem duplicar;
 *   - o ritmo da campanha (intervalo fixo, teto por número) é configurável e auditado;
 *   - a lista de alvos traz só campanha RODANDO, a mais antiga primeiro;
 *   - as funções recriadas não deixam a assinatura antiga para trás (ambiguidade no RPC).
 *
 * ⚠️ Corrida REAL entre duas conexões não é exercitada (ver o cabeçalho do arquivo do núcleo):
 * aqui prova-se a regra que a reserva exclusiva aplica DENTRO de uma transação.
 */

const ORG = GOV_ORG;

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
let base = 300_000_000 + Math.floor(Math.random() * 600_000_000);

beforeAll(() => {
  seedGov();
});

/**
 * Um número NOVO por teste: a reserva exclusiva é por número, e um teste que deixa contato
 * em voo num número compartilhado faria o seguinte falhar por causa dele — não do produto.
 */
let seqCanal = 0;
function novoCanal(): string {
  const id = q(`select gen_random_uuid()::text`);
  sql(`insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
         values ('${id}', '${ORG}', 'desp-${Date.now().toString(36)}-${++seqCanal}', '\\x00'::bytea, 'WORKING')`);
  return id;
}

function campanha(contatos: number, canais: string[], iniciar = true): string {
  const id = q(`select public.fn_campaign_create('${ORG}', 'Despacho ${Math.random().toString(36).slice(2, 8)}', '${GOV_ADMIN}')`);
  sql(`
    select public.fn_campaign_create_version('${ORG}', '${id}', 'Oi {{nome}}', '${GOV_ADMIN}');
    select public.fn_campaign_set_channels('${ORG}', '${id}', array[${canais.map((c) => `'${c}'::uuid`).join(",")}], '${GOV_ADMIN}');
  `);
  const inicio = base;
  base += contatos + 1;
  sql(`
    with c as (insert into public.contacts (organization_id, display_name, phone_number)
      select '${ORG}', 'D ' || g, '+5511' || (${inicio} + g)::text from generate_series(1, ${contatos}) g returning id)
    insert into public.campaign_contacts (organization_id, campaign_id, contact_id) select '${ORG}', '${id}', id from c;
  `);
  if (iniciar) sql(`select public.fn_campaign_transition('${ORG}', '${id}', 'start', '${GOV_ADMIN}')`);
  return id;
}

interface Reserva {
  id: string;
  token: string;
}
function reservar(camp: string, canal: string, n: number, exclusivo: boolean): Reserva[] {
  return sql(
    `select campaign_contact_id || '|' || claim_token from public.fn_campaign_claim_batch('${ORG}', '${camp}', '${canal}', ${n}, 90, ${exclusivo})`,
  )
    .split("\n")
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [id, token] = l.split("|") as [string, string];
      return { id, token };
    });
}
const iniciarEnvio = (r: Reserva) =>
  json<{ decision: string }>(`select public.fn_campaign_begin_send('${ORG}', '${r.id}', '${r.token}')::text`);
const concluir = (r: Reserva) => q(`select public.fn_campaign_mark_sent('${ORG}', '${r.id}', '${r.token}', null, 'ext')`);

describe("Central de Disparos — reserva exclusiva por número", () => {
  it("as funções recriadas não deixam a assinatura antiga (ambiguidade no RPC)", () => {
    for (const fn of ["fn_campaign_claim_batch", "fn_campaign_update_settings", "fn_campaign_resolve_uncertain", "fn_campaign_dispatch_targets"]) {
      expect(q(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '${fn}'`), fn).toBe("1");
      expect(q(`select has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("f");
      expect(q(`select has_function_privilege('service_role', p.oid, 'execute') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${fn}'`), fn).toBe("t");
    }
  });

  it("com um contato em voo no número, a reserva exclusiva devolve nada; a comum continua funcionando", () => {
    const ch = novoCanal();
    const c = campanha(6, [ch]);
    const [primeiro] = reservar(c, ch, 1, true) as [Reserva];
    expect(primeiro).toBeDefined();
    // Em voo: reservado (queued) e depois em envio (processing) — nos dois estados o número está ocupado.
    expect(reservar(c, ch, 1, true)).toHaveLength(0);
    expect(iniciarEnvio(primeiro).decision).toBe("send");
    expect(reservar(c, ch, 1, true)).toHaveLength(0);
    // Terminou o envio: o número fica livre para o próximo.
    expect(concluir(primeiro)).toBe("ok");
    expect(reservar(c, ch, 1, true)).toHaveLength(1);
  });

  it("a reserva NÃO exclusiva (lotes, testes) não é afetada pelo contato em voo", () => {
    const ch = novoCanal();
    const c = campanha(6, [ch]);
    reservar(c, ch, 1, true);
    expect(reservar(c, ch, 2, false)).toHaveLength(2);
  });

  it("libera o número quando o envio termina e quando a lease vence; outro número não é afetado", () => {
    const [chA, chB] = [novoCanal(), novoCanal()] as [string, string];
    const c = campanha(6, [chA, chB]);
    const [a] = reservar(c, chA, 1, true) as [Reserva];
    // O outro número da mesma campanha segue livre.
    const [b] = reservar(c, chB, 1, true) as [Reserva];
    expect(b).toBeDefined();
    expect(reservar(c, chA, 1, true)).toHaveLength(0);
    // A lease de A venceu (worker morreu antes do begin_send): não trava o número para sempre.
    sql(`update public.campaign_contacts set lease_expires_at = now() - interval '1 minute' where id = '${a.id}'`);
    expect(reservar(c, chA, 1, true)).toHaveLength(1);
  });

  it("vale entre campanhas: duas campanhas no mesmo número não mandam ao mesmo tempo", () => {
    const ch = novoCanal();
    const c1 = campanha(3, [ch]);
    const c2 = campanha(3, [ch]);
    expect(reservar(c1, ch, 1, true)).toHaveLength(1);
    expect(reservar(c2, ch, 1, true)).toHaveLength(0);
  });
});

describe("Central de Disparos — resolver o incerto", () => {
  function incerto(c: string, ch: string): Reserva {
    const [r] = reservar(c, ch, 1, false) as [Reserva];
    iniciarEnvio(r);
    sql(`select public.fn_campaign_mark_uncertain('${ORG}', '${r.id}', '${r.token}', 'timeout', 'sem resposta')`);
    return r;
  }
  const resolver = (r: Reserva, como: string) =>
    q(`select public.fn_campaign_resolve_uncertain('${ORG}', '${r.id}', '${como}', '${GOV_ADMIN}')`);

  it("'enviado' confirma o envio e registra na trilha quem resolveu; repetir não duplica", () => {
    const ch = novoCanal();
    const c = campanha(3, [ch]);
    const r = incerto(c, ch);
    expect(resolver(r, "sent")).toBe("ok");
    expect(q(`select status from public.campaign_contacts where id = '${r.id}'`)).toBe("sent");
    expect(resolver(r, "sent")).toBe("already");
    expect(q(`select count(*) from public.campaign_events where campaign_contact_id = '${r.id}' and kind = 'sent'`)).toBe("1");
    expect(q(`select payload->>'resolved_manually' from public.campaign_events where campaign_contact_id = '${r.id}' and kind = 'sent'`)).toBe("true");
  });

  it("'tentar de novo' devolve o contato à MESMA posição da fila", () => {
    const ch = novoCanal();
    const c = campanha(4, [ch]);
    const r = incerto(c, ch);
    const seq = q(`select seq from public.campaign_contacts where id = '${r.id}'`);
    expect(resolver(r, "retry")).toBe("ok");
    expect(q(`select status || '/' || coalesce(claim_token::text, '-') from public.campaign_contacts where id = '${r.id}'`)).toBe("pending/-");
    expect(q(`select seq from public.campaign_contacts where id = '${r.id}'`)).toBe(seq);
    // É o menor `seq` pendente da campanha: o próximo a ser reservado.
    expect(reservar(c, ch, 1, false)[0]!.id).toBe(r.id);
  });

  it("'falhou' encerra sem reenviar", () => {
    const ch = novoCanal();
    const c = campanha(3, [ch]);
    const r = incerto(c, ch);
    expect(resolver(r, "failed")).toBe("ok");
    expect(q(`select status from public.campaign_contacts where id = '${r.id}'`)).toBe("failed");
    expect(q(`select count(*) from public.campaign_events where campaign_contact_id = '${r.id}' and kind = 'send_failed'`)).toBe("1");
  });

  it("só resolve o que está incerto, com resolução válida e dentro da organização", () => {
    const ch = novoCanal();
    const c = campanha(3, [ch]);
    const [pendente] = reservar(c, ch, 1, false) as [Reserva];
    expect(resolver(pendente, "sent")).toBe("not_uncertain");
    expect(erro(`select public.fn_campaign_resolve_uncertain('${ORG}', '${pendente.id}', 'talvez', null)`)).toMatch(/campaign_invalid_action/);
    expect(erro(`select public.fn_campaign_resolve_uncertain('dddddddd-0000-4000-8000-00000000ffff', '${pendente.id}', 'sent', null)`)).toMatch(/campaign_not_found/);
  });

  it("não devolve à fila o incerto de uma campanha encerrada", () => {
    const ch = novoCanal();
    const c = campanha(3, [ch]);
    const r = incerto(c, ch);
    sql(`select public.fn_campaign_transition('${ORG}', '${c}', 'complete', '${GOV_ADMIN}')`);
    expect(erro(`select public.fn_campaign_resolve_uncertain('${ORG}', '${r.id}', 'retry', null)`)).toMatch(/campaign_closed/);
    // Mas confirmar que saiu continua possível: é registro de um fato.
    expect(resolver(r, "sent")).toBe("ok");
  });
});

describe("Central de Disparos — ritmo da campanha e alvos do despacho", () => {
  it("nasce com intervalo de 180s e sem teto próprio; mudar é auditado com antes/depois", () => {
    const c = campanha(1, [novoCanal()], false);
    expect(q(`select send_interval_seconds || '/' || coalesce(daily_cap_per_channel::text, 'null') from public.campaigns where id = '${c}'`)).toBe("180/null");
    const r = json<{ changed: boolean; changes: Record<string, { from: unknown; to: unknown }> }>(
      `select public.fn_campaign_update_settings('${ORG}', '${c}', '${GOV_ADMIN}', null, null, null, 60, 120)::text`,
    );
    expect(r.changed).toBe(true);
    expect(r.changes.send_interval_seconds).toEqual({ from: 180, to: 60 });
    expect(r.changes.daily_cap_per_channel).toEqual({ from: null, to: 120 });
    // Nada mudou: nada registrado.
    expect(json(`select public.fn_campaign_update_settings('${ORG}', '${c}', '${GOV_ADMIN}', null, null, null, 60, 120)::text`)).toMatchObject({ changed: false });
    // `null` já significa "não mexer": para VOLTAR ao teto do número existe o clear.
    expect(json(`select public.fn_campaign_update_settings('${ORG}', '${c}', '${GOV_ADMIN}', null, null, null, null, null, true)::text`)).toMatchObject({ changed: true });
    expect(q(`select daily_cap_per_channel is null from public.campaigns where id = '${c}'`)).toBe("t");
    expect(q(`select count(*) from public.campaign_events where campaign_id = '${c}' and kind = 'settings_changed'`)).toBe("2");
  });

  it("recusa intervalo e teto fora da faixa", () => {
    const c = campanha(1, [novoCanal()], false);
    expect(erro(`select public.fn_campaign_update_settings('${ORG}', '${c}', null, null, null, null, 5)`)).toMatch(/check constraint/);
    expect(erro(`select public.fn_campaign_update_settings('${ORG}', '${c}', null, null, null, null, 4000)`)).toMatch(/check constraint/);
    expect(erro(`select public.fn_campaign_update_settings('${ORG}', '${c}', null, null, null, null, null, 0)`)).toMatch(/check constraint/);
  });

  it("os alvos são só as campanhas RODANDO, cada uma com seus números e o estado deles", () => {
    const [chA, chB] = [novoCanal(), novoCanal()] as [string, string];
    const rodando = campanha(2, [chA, chB]);
    const rascunho = campanha(2, [chA], false);
    const pausada = campanha(2, [chA]);
    sql(`select public.fn_campaign_transition('${ORG}', '${pausada}', 'pause', '${GOV_ADMIN}')`);
    const alvos = json<Array<{ campaign_id: string; channel_session_id: string; channel_status: string; send_interval_seconds: number; channel_policy: string }>>(
      `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from public.fn_campaign_dispatch_targets(2000) t
         where t.campaign_id in ('${rodando}', '${rascunho}', '${pausada}')`,
    );
    const daRodando = alvos.filter((a) => a.campaign_id === rodando);
    expect(daRodando.map((a) => a.channel_session_id).sort()).toEqual([chA, chB].sort());
    expect(daRodando[0]).toMatchObject({ channel_status: "WORKING", send_interval_seconds: 180, channel_policy: "skip_channel" });
    expect(alvos.some((a) => a.campaign_id === rascunho)).toBe(false);
    expect(alvos.some((a) => a.campaign_id === pausada)).toBe(false);
  });

  it("mostra o número desconectado em vez de escondê-lo (a política da campanha decide o que fazer)", () => {
    const [chA, chB] = [novoCanal(), novoCanal()] as [string, string];
    const c = campanha(2, [chA, chB]);
    sql(`update public.channel_sessions set status = 'STOPPED' where id = '${chB}'`);
    try {
      const alvos = json<Array<{ campaign_id: string; channel_session_id: string; channel_status: string }>>(
        `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from public.fn_campaign_dispatch_targets(2000) t where t.campaign_id = '${c}'`,
      );
      expect(alvos.find((a) => a.channel_session_id === chB)?.channel_status).toBe("STOPPED");
      expect(alvos.find((a) => a.channel_session_id === chA)?.channel_status).toBe("WORKING");
    } finally {
      sql(`update public.channel_sessions set status = 'WORKING' where id = '${chB}'`);
    }
  });
});
