import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { entradasSemIdentificacao, medicaoDoDestino, duracaoEmPalavras, estimativaDeEnvio, revisaoDaCampanha, usaLinkDoGrupo, estadoDoContato, filtroRapidoDoStatus, FILTROS_RAPIDOS, contextoDeNomes, MOTIVO_DO_VETO, rotuloDoCanal, acoesDaCampanha, destinoDoAlerta, dataHoraCurta, frasesDoEvento, funil, haQuantoTempo, horaCompleta, MOTIVO_DE_IGNORADO, MOTIVO_DE_REJEICAO, numero, percentual, ROTULO_DA_CAMPANHA, ROTULO_DO_ESTADO_DO_CONTATO, ROTULO_DO_ENVIO } from "@/lib/campaigns/formato";
import { ROTULO_DO_MOTIVO } from "@/lib/campaigns/importacao";
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
    expect(f("blocked")).toBe("Bloqueou os próximos envios desta campanha");
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
    expect(dataHoraCurta("2026-09-21T15:04:32Z", "pt-BR")).toBe("21/09 12:04");
    expect(dataHoraCurta("2026-09-21T15:04:32Z", "es")).toBe("21/09 12:04");
    expect(horaCompleta("2026-09-21T15:04:32Z", "pt-BR")).toBe("12:04:32");
    expect(dataHoraCurta(null, "pt-BR")).toBe("—");
    expect(dataHoraCurta("lixo", "pt-BR")).toBe("—");
  });
  it("há quanto tempo", () => {
    const agora = new Date("2026-09-21T15:00:00Z");
    expect(haQuantoTempo("2026-09-21T14:59:50Z", agora)).toBe("agora");
    expect(haQuantoTempo("2026-09-21T14:55:00Z", agora)).toBe("há 5 min");
    expect(haQuantoTempo("2026-09-21T12:00:00Z", agora)).toBe("há 3 h");
    expect(haQuantoTempo("2026-09-19T15:00:00Z", agora)).toBe("há 2 d");
    expect(haQuantoTempo(null, agora)).toBe("—");
    // Com um tradutor, a frase inteira é a chave e o {n} é preenchido depois.
    const es = (x: string) => ({ "há {n} min": "hace {n} min", agora: "ahora" })[x] ?? x;
    expect(haQuantoTempo("2026-09-21T14:55:00Z", agora, es)).toBe("hace 5 min");
    expect(haQuantoTempo("2026-09-21T14:59:50Z", agora, es)).toBe("ahora");
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

describe("nomes para as frases", () => {
  it("monta versão, grupo e número a partir da Visão geral, com nome de número que nunca fica em branco", () => {
    const c = contextoDeNomes({
      versions: [{ id: "v1", version_no: 1 }, { id: "v2", version_no: 2 }],
      destinations: [{ id: "d1", name: "BLACK #01" }],
      channels: [
        { channel_session_id: "c1", session: { display_name: "Número 01", phone_number: "5511999990001" } },
        { channel_session_id: "c2", session: { display_name: null, phone_number: "5511999990002" } },
        { channel_session_id: "c3", session: null },
      ],
    });
    expect(c.versoes).toEqual({ v1: 1, v2: 2 });
    expect(c.destinos).toEqual({ d1: "BLACK #01" });
    expect(c.canais).toEqual({ c1: "Número 01", c2: "5511999990002", c3: "Número sem nome" });
    expect(rotuloDoCanal({ display_name: "  ", phone_number: null })).toBe("Número sem nome");
  });
  it("todo veto de ritmo tem explicação", () => {
    expect(Object.keys(MOTIVO_DO_VETO).sort()).toEqual(["campaign_cap", "daily_cap", "interval", "outside_window", "warmup_cap"]);
  });
});

describe("Fila: filtros rápidos e estado do contato", () => {
  it("todo status que um filtro manda à API existe no vocabulário do banco", () => {
    for (const f of FILTROS_RAPIDOS) for (const st of f.filtro.status ?? []) expect(CAMPAIGN_CONTACT_STATUSES, f.id).toContain(st);
  });
  it("os botões dos alertas (?status=failed|uncertain) acendem o filtro certo", () => {
    expect(filtroRapidoDoStatus("failed")).toBe("falhas");
    expect(filtroRapidoDoStatus("uncertain")).toBe("incertos");
    expect(filtroRapidoDoStatus("sent")).toBe("enviados");
    expect(filtroRapidoDoStatus("qualquer-coisa")).toBe("todos");
    expect(filtroRapidoDoStatus(null)).toBe("todos");
  });
  it("o estado é o estágio mais avançado: entrou no grupo vence respondeu, que vence clicou", () => {
    const base = { status: "sent" as const, clicked_at: null, replied_at: null, joined_at: null, left_at: null };
    expect(estadoDoContato(base)).toBe("ENVIADO");
    expect(estadoDoContato({ ...base, clicked_at: "x" })).toBe("CLICOU");
    expect(estadoDoContato({ ...base, clicked_at: "x", replied_at: "x" })).toBe("RESPONDEU");
    expect(estadoDoContato({ ...base, clicked_at: "x", replied_at: "x", joined_at: "x" })).toBe("NO_GRUPO");
    expect(estadoDoContato({ ...base, joined_at: "x", left_at: "y" })).toBe("SAIU_DO_GRUPO");
    expect(estadoDoContato({ ...base, status: "uncertain" as never })).toBe("INCERTO");
  });
});

describe("motivos de rejeição do CSV: a tela e o arquivo baixado dizem a mesma coisa", () => {
  it("os rótulos do cliente são idênticos aos do servidor", () => {
    expect(MOTIVO_DE_REJEICAO).toEqual(ROTULO_DO_MOTIVO);
  });
});

describe("assistente: o que falta para iniciar (espelho do banco)", () => {
  const pronto = { pendentes: 45000, corpoAtivo: "Oi {{nome}}, entre: {{link_grupo}}", temDestinoAtivo: true, numerosEscolhidos: 2 };
  it("tudo pronto: nada pendente", () => {
    expect(revisaoDaCampanha(pronto).every((i) => i.ok)).toBe(true);
  });
  it("aponta o que falta, na ordem do assistente", () => {
    const falta = revisaoDaCampanha({ pendentes: 0, corpoAtivo: null, temDestinoAtivo: false, numerosEscolhidos: 0 });
    expect(falta.filter((i) => !i.ok).map((i) => i.id)).toEqual(["contatos", "mensagem", "envio"]);
    // Sem mensagem o texto não usa link: o destino não é exigido (o banco também não exige).
  });
  it("destino só é exigido quando o texto usa {{link_grupo}} — em qualquer caixa, como o banco", () => {
    expect(revisaoDaCampanha({ ...pronto, corpoAtivo: "Promoção hoje", temDestinoAtivo: false }).find((i) => i.id === "destino")!.ok).toBe(true);
    expect(revisaoDaCampanha({ ...pronto, temDestinoAtivo: false }).find((i) => i.id === "destino")!.ok).toBe(false);
    expect(usaLinkDoGrupo("Entre: {{ Link_Grupo }}")).toBe(true);
    expect(usaLinkDoGrupo(null)).toBe(false);
  });
});

describe("assistente: quanto tempo leva", () => {
  it("45 mil com um número de 300/dia levam cerca de 150 dias; com mais números cai na proporção", () => {
    expect(estimativaDeEnvio({ pendentes: 45000, limitesDiarios: [300], intervaloSegundos: 180, tetoDaCampanha: null })).toEqual({ porDia: 300, dias: 150 });
    expect(estimativaDeEnvio({ pendentes: 45000, limitesDiarios: [300, 300, 300], intervaloSegundos: 180, tetoDaCampanha: null })).toEqual({ porDia: 900, dias: 50 });
  });
  it("o intervalo também limita: com 600s cabem 144 por dia, mesmo que o número aceite 300", () => {
    expect(estimativaDeEnvio({ pendentes: 1440, limitesDiarios: [300], intervaloSegundos: 600, tetoDaCampanha: null })).toEqual({ porDia: 144, dias: 10 });
  });
  it("o teto da campanha só reduz, nunca aumenta o limite do número", () => {
    expect(estimativaDeEnvio({ pendentes: 1000, limitesDiarios: [300], intervaloSegundos: 60, tetoDaCampanha: 100 }).porDia).toBe(100);
    expect(estimativaDeEnvio({ pendentes: 1000, limitesDiarios: [300], intervaloSegundos: 60, tetoDaCampanha: 5000 }).porDia).toBe(300);
  });
  it("sem número não há estimativa (nunca 'Infinity dias')", () => {
    expect(estimativaDeEnvio({ pendentes: 1000, limitesDiarios: [], intervaloSegundos: 180, tetoDaCampanha: null })).toEqual({ porDia: 0, dias: null });
    expect(duracaoEmPalavras(null)).toBe("não dá para estimar");
  });
  it("fala em dias, semanas e meses", () => {
    expect(duracaoEmPalavras(1)).toBe("menos de 1 dia");
    expect(duracaoEmPalavras(5)).toBe("cerca de 5 dias");
    expect(duracaoEmPalavras(21)).toBe("cerca de 3 semanas");
    expect(duracaoEmPalavras(150)).toBe("cerca de 5 meses");
    expect(duracaoEmPalavras(21, (x) => (x === "cerca de {n} semanas" ? "unas {n} semanas" : x))).toBe("unas 3 semanas");
  });
});

describe("entradas e saídas do grupo: o que o CRM enxerga", () => {
  it("três estados: sem ID não monitora; com ID e sem aviso AGUARDA (não é zero); com aviso, mede", () => {
    expect(medicaoDoDestino({ group_chat_id: null, joined_total: 10, members_left: 3 })).toBe("nao_monitorado");
    expect(medicaoDoDestino({ group_chat_id: "1203@g.us", joined_total: 0, members_left: 0 })).toBe("aguardando");
    expect(medicaoDoDestino({ group_chat_id: "1203@g.us" })).toBe("aguardando"); // 0286 ainda não aplicada: campos ausentes
    expect(medicaoDoDestino({ group_chat_id: "1203@g.us", joined_total: 1, members_left: 0 })).toBe("medido");
    // Só chegou uma SAÍDA (nunca vimos a entrada): já é evidência de que o aviso funciona.
    expect(medicaoDoDestino({ group_chat_id: "1203@g.us", joined_total: 0, members_left: 1 })).toBe("medido");
  });
  it("entradas sem identificação: o total de pessoas que entraram menos as identificadas, nunca negativo", () => {
    expect(entradasSemIdentificacao([{ joined_total: 2000 }, { joined_total: 300 }], 1731)).toBe(569);
    expect(entradasSemIdentificacao([{ joined_total: 10 }], 25)).toBe(0);
    expect(entradasSemIdentificacao([{}, { joined_total: null }], 0)).toBe(0);
  });
});
