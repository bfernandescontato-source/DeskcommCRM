import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { acoesDaCampanha, destinoDoAlerta, dataHoraCurta, frasesDoEvento, funil, haQuantoTempo, horaCompleta, MOTIVO_DE_IGNORADO, MOTIVO_DE_REJEICAO, numero, percentual, ROTULO_DA_CAMPANHA, ROTULO_DO_ESTADO_DO_CONTATO, ROTULO_DO_ENVIO } from "@/lib/campaigns/formato";
import { CAMPAIGN_CONTACT_STATUSES, CAMPAIGN_EVENT_KINDS, CAMPAIGN_IMPORT_REJECT_REASONS, CAMPAIGN_SKIP_REASONS, CAMPAIGN_STATUSES } from "@/lib/campaigns/vocabulario";

describe("números", () => {
  it("formata em português e nunca devolve NaN", () => {
    expect(numero(12540)).toMatch(/^12\.540$/);
    expect(numero(45000)).toMatch(/^45\.000$/);
    expect(numero(0)).toBe("0");
    expect(numero(null)).toBe("—");
    expect(numero(undefined)).toBe("—");
    expect(numero(Number.NaN)).toBe("—");
  });
  it("taxa sem base é '—', não 0%", () => {
    expect(percentual(634, 771)).toBe("82,2%");
    expect(percentual(37, 521)).toBe("7,1%");
    expect(percentual(0, 100)).toBe("0,0%");
    expect(percentual(5, 0)).toBe("—");
    expect(percentual(5, null)).toBe("—");
    expect(percentual(undefined, 10)).toBe("—");
  });
});

describe("rótulos cobrem todo o vocabulário do banco", () => {
  it("todo estado de campanha e de envio tem rótulo", () => {
    for (const s of CAMPAIGN_STATUSES) expect(ROTULO_DA_CAMPANHA[s], s).toBeDefined();
    for (const s of CAMPAIGN_CONTACT_STATUSES) expect(ROTULO_DO_ENVIO[s], s).toBeDefined();
  });
  it("os estados do contato que a API devolve têm rótulo", () => {
    for (const s of ["NO_GRUPO", "SAIU_DO_GRUPO", "RESPONDEU", "CLICOU", "ENVIADO", "PENDENTE", "PROCESSANDO", "FALHOU", "INCERTO", "IGNORADO", "CANCELADO"]) {
      expect(ROTULO_DO_ESTADO_DO_CONTATO[s], s).toBeDefined();
    }
  });
});

describe("nenhum vocabulário do banco fica sem frase", () => {
  it("todo motivo de ignorado e de rejeição de CSV tem texto em português", () => {
    for (const r of CAMPAIGN_SKIP_REASONS) expect(MOTIVO_DE_IGNORADO[r], r).toBeTruthy();
    for (const r of CAMPAIGN_IMPORT_REJECT_REASONS) expect(MOTIVO_DE_REJEICAO[r], r).toBeTruthy();
  });
  it("todo tipo de evento tem frase própria — nunca o nome técnico cru", () => {
    for (const kind of CAMPAIGN_EVENT_KINDS) {
      const frase = frasesDoEvento({ kind, payload: {} }, { versoes: {}, destinos: {}, canais: {} });
      expect(frase, kind).not.toBe(kind);
      expect(frase, kind).not.toMatch(/undefined|null|\[object/);
    }
  });
  it("configuração alterada cita o que mudou, em português", () => {
    const f = frasesDoEvento({ kind: "settings_changed", actor_name: "Bruno", payload: { send_interval_seconds: { from: 180, to: 240 }, name: { from: "a", to: "b" } } }, { versoes: {}, destinos: {}, canais: {} });
    expect(f).toBe("Bruno alterou intervalo entre envios, nome");
  });
});

describe("funil", () => {
  const c = { total: 45000, sent: 8420, clicked: 2184, joined: 1731, left: 146 };
  it("contatos -> enviados -> clicaram -> entraram -> saíram -> permanecem, com as taxas certas", () => {
    const { etapas, taxas } = funil(c, true);
    expect(etapas.map((e) => [e.chave, e.valor])).toEqual([["total", 45000], ["sent", 8420], ["clicked", 2184], ["joined", 1731], ["left", 146], ["stayed", 1585]]);
    expect(Object.fromEntries(taxas.map((t) => [t.rotulo, t.valor]))).toEqual({
      "Taxa de envio": "18,7%",
      "CTR (clique / enviado)": "25,9%",
      "Clique → entrada": "79,3%",
      "Taxa de saída": "8,4%",
      "Taxa de permanência": "91,6%",
    });
  });
  it("sem entradas MEDIDAS, entraram/saíram/permanecem são 'não medido' — nunca zero", () => {
    const { etapas, taxas } = funil({ ...c, joined: 0, left: 0 }, false);
    for (const chave of ["joined", "left", "stayed"]) {
      const e = etapas.find((x) => x.chave === chave)!;
      expect(e.valor, chave).toBeNull();
      expect(e.nota, chave).toBe("não medido");
    }
    expect(taxas.filter((t) => t.valor === "não medido")).toHaveLength(3);
    // O que é medido continua aparecendo.
    expect(etapas.find((x) => x.chave === "clicked")!.valor).toBe(2184);
  });
  it("saiu mais gente do que entrou (dado inconsistente) não vira permanência negativa", () => {
    expect(funil({ total: 10, sent: 10, clicked: 5, joined: 2, left: 5 }, true).etapas.find((x) => x.chave === "stayed")!.valor).toBe(0);
  });
});

describe("frases dos eventos — o que um operador lê", () => {
  const ctx = { versoes: { v1: 1, v2: 2 }, destinos: { d4: "BLACK #04" }, canais: { c1: "Número 01" } };
  const f = (kind: string, extra: Record<string, unknown> = {}) => frasesDoEvento({ kind, payload: {}, ...extra }, ctx);

  it("mudanças de operação dizem QUEM e de → para", () => {
    expect(f("version_activated", { actor_name: "Bruno", payload: { from_version_no: 2, to_version_no: 3 } })).toBe("Bruno alterou a mensagem V2 → V3");
    expect(f("destination_changed", { actor_name: "Bruno", payload: { from_name: "BLACK #04", to_name: "BLACK #05" } })).toBe("Bruno alterou o destino BLACK #04 → BLACK #05");
    expect(f("destination_changed", { payload: { to_name: "BLACK #01" } })).toBe("definiu o destino BLACK #01".replace(/^d/, "d"));
    expect(f("started", { actor_name: "Bruno" })).toBe("Bruno iniciou a campanha");
    expect(f("paused", { actor_name: "Bruno", payload: { reason: "manual" } })).toBe("Bruno pausou a campanha");
    expect(f("paused", { payload: { reason: "no_channel" } })).toBe("pausou a campanha (nenhum número conectado)");
  });

  it("a linha do tempo do contato usa a versão, o número e o grupo do MOMENTO", () => {
    expect(f("sent", { message_version_id: "v2", channel_session_id: "c1" })).toBe("Mensagem V2 enviada por Número 01");
    expect(f("joined", { destination_id: "d4" })).toBe("Entrou no BLACK #04");
    expect(f("left", { destination_id: "d4" })).toBe("Saiu do BLACK #04");
    expect(f("replied")).toBe("Respondeu");
    expect(f("clicked")).toBe("Link clicado");
  });

  it("envio confirmado à mão, ignorado e incerto ficam claros", () => {
    expect(f("sent", { payload: { resolved_manually: true } })).toContain("confirmado por uma pessoa");
    expect(f("skipped", { payload: { reason: "declined_marketing" } })).toBe("Não enviado: recusou receber mensagens");
    expect(f("uncertain")).toContain("incerto");
    expect(f("send_failed", { payload: { code: "missing_variable" } })).toBe("Falha no envio (missing_variable)");
  });

  it("importação e conclusão automática", () => {
    expect(f("imported", { actor_name: "Ana", payload: { imported: 44732, rejected: 268 } })).toMatch(/Ana importou um CSV: 44\.732 contatos, 268 recusados/);
    expect(f("completed", { payload: { reason: "all_processed" } })).toContain("todos os contatos foram processados");
  });

  it("tipo desconhecido não quebra a tela", () => {
    expect(f("algo_novo")).toBe("algo_novo");
  });
});

describe("datas", () => {
  it("data e hora curtas no fuso da organização", () => {
    expect(dataHoraCurta("2026-09-21T15:04:32Z")).toBe("21/09 12:04");
    expect(horaCompleta("2026-09-21T15:04:32Z")).toBe("12:04:32");
    expect(dataHoraCurta(null)).toBe("—");
    expect(dataHoraCurta("lixo")).toBe("—");
  });
  it("há quanto tempo", () => {
    const agora = new Date("2026-09-21T15:00:00Z");
    expect(haQuantoTempo("2026-09-21T14:59:50Z", agora)).toBe("agora");
    expect(haQuantoTempo("2026-09-21T14:55:00Z", agora)).toBe("há 5 min");
    expect(haQuantoTempo("2026-09-21T12:00:00Z", agora)).toBe("há 3 h");
    expect(haQuantoTempo("2026-09-19T15:00:00Z", agora)).toBe("há 2 d");
    expect(haQuantoTempo(null, agora)).toBe("—");
  });
});

describe("ações por estado — espelho da máquina de estados do banco", () => {
  const sql = readFileSync("supabase/migrations/20260921180000_0280_central_de_disparos_nucleo.sql", "utf8");
  // As linhas `(p_action = 'x' and c.status in ('a','b'))` de fn_campaign_transition, lidas do próprio SQL.
  const matriz = new Map<string, string[]>();
  for (const m of sql.matchAll(/\(p_action = '(\w+)'\s+and c\.status (?:in \(([^)]*)\)|= '(\w+)')\)/g)) {
    matriz.set(m[1]!, (m[2] ?? m[3]!).split(",").map((x) => x.replace(/['\s]/g, "")));
  }

  it("leu a matriz do banco (não é uma tabela vazia que passa por acaso)", () => {
    expect([...matriz.keys()].sort()).toEqual(["cancel", "complete", "fail", "pause", "ready", "resume", "start"]);
  });

  it("todo botão que a tela oferece é uma transição que o banco aceita a partir daquele estado", () => {
    for (const status of CAMPAIGN_STATUSES) {
      for (const a of acoesDaCampanha(status)) {
        expect(matriz.get(a.acao), `${a.acao} a partir de ${status}`).toContain(status);
      }
    }
  });

  it("estado final não oferece nada; encerrar e descartar pedem confirmação; pausar e retomar não", () => {
    expect(acoesDaCampanha("completed")).toEqual([]);
    expect(acoesDaCampanha("cancelled")).toEqual([]);
    for (const status of CAMPAIGN_STATUSES) {
      for (const a of acoesDaCampanha(status)) {
        if (a.acao === "complete" || a.acao === "cancel" || a.acao === "start") expect(a.confirmar, a.acao).toBe(true);
        if (a.acao === "pause" || a.acao === "resume") expect(a.confirmar, a.acao).toBe(false);
        if (a.confirmar) expect(a.aviso, a.acao).toBeTruthy();
      }
    }
  });

  it("PAUSAR e ENCERRAR são explicados de forma diferente", () => {
    const enc = acoesDaCampanha("running").find((a) => a.acao === "complete")!;
    expect(enc.aviso).toMatch(/de vez/);
    expect(enc.aviso).toMatch(/Pausar/);
  });
});

describe("alerta -> tela", () => {
  it("cada ação de alerta leva à aba certa; informação pura não leva a lugar nenhum", () => {
    expect(destinoDoAlerta("c1", { action: "switch_destination" })).toBe("/app/disparos/c1?aba=destinos");
    expect(destinoDoAlerta("c1", { action: "review_failures" })).toBe("/app/disparos/c1?aba=fila&status=failed");
    expect(destinoDoAlerta("c1", { action: "review_uncertain" })).toBe("/app/disparos/c1?aba=fila&status=uncertain");
    expect(destinoDoAlerta("c1", { action: "none" })).toBeNull();
  });
});
