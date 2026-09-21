import { describe, expect, it } from "vitest";

import {
  AMOSTRA_MINIMA_DE_FALHA,
  calcularAlertas,
  ocupacaoDoDestino,
  type RetratoDaCampanha,
} from "@/lib/campaigns/alertas";
import { estadoDoContato, linhaDaFila, rotuloDoNumero, termoDaBusca } from "@/lib/campaigns/leituras";
import { filaQuerySchema } from "@/lib/campaigns/schemas";

const retrato = (o: Partial<RetratoDaCampanha> = {}): RetratoDaCampanha => ({
  status: "running",
  statusReason: null,
  counts: { pending: 100, sent: 50, failed: 0, uncertain: 0 },
  channels: [{ label: "Número 01", status: "WORKING", enabled: true }],
  destinations: [{ name: "BLACK #04", status: "active", capacity: 950, directed: 100, joined: 60, left: 5, measured: true }],
  lastImport: null,
  ...o,
});
const codigos = (r: RetratoDaCampanha) => calcularAlertas(r).map((a) => a.code);

describe("alertas — só o que exige atenção", () => {
  it("campanha saudável não gera nenhum alerta", () => {
    expect(calcularAlertas(retrato())).toEqual([]);
  });

  it("grupo próximo da capacidade avisa e oferece TROCAR DESTINO — nunca troca sozinho", () => {
    const perto = retrato({ destinations: [{ name: "BLACK #04", status: "active", capacity: 950, directed: 0, joined: 928, left: 5, measured: true }] });
    const [a] = calcularAlertas(perto);
    expect(a).toMatchObject({ level: "warning", code: "capacity_near", action: "switch_destination", subject: "BLACK #04" });
    expect(a!.message).toContain("923 / 950");
  });

  it("grupo cheio é crítico; grupo já encerrado não alerta; sem capacidade configurada não alerta", () => {
    const cheio = retrato({ destinations: [{ name: "B1", status: "active", capacity: 100, directed: 0, joined: 110, left: 0, measured: true }] });
    expect(calcularAlertas(cheio)[0]).toMatchObject({ level: "critical", code: "capacity_full" });
    expect(codigos(retrato({ destinations: [{ name: "B1", status: "closed", capacity: 100, directed: 0, joined: 110, left: 0, measured: true }] }))).toEqual([]);
    expect(codigos(retrato({ destinations: [{ name: "B1", status: "active", capacity: null, directed: 5000, joined: 0, left: 0, measured: true }] }))).toEqual([]);
  });

  it("sem entradas MEDIDAS a ocupação é o que foi direcionado, e o texto diz isso (nunca finge medir)", () => {
    const d = { name: "B1", status: "active", capacity: 100, directed: 95, joined: 0, left: 0, measured: false };
    expect(ocupacaoDoDestino(d)).toEqual({ usado: 95, base: "directed" });
    expect(calcularAlertas(retrato({ destinations: [d] }))[0]!.message).toContain("direcionados");
    expect(ocupacaoDoDestino({ ...d, measured: true, joined: 10, left: 30 })).toEqual({ usado: 0, base: "members" });
  });

  it("número desconectado avisa o número; todos desconectados é crítico", () => {
    const um = retrato({ channels: [{ label: "Número 01", status: "WORKING", enabled: true }, { label: "Número 03", status: "STOPPED", enabled: true }] });
    expect(calcularAlertas(um)).toEqual([expect.objectContaining({ level: "warning", code: "channel_down", subject: "Número 03" })]);
    const todos = retrato({ channels: [{ label: "Número 01", status: "STOPPED", enabled: true }] });
    expect(calcularAlertas(todos)[0]).toMatchObject({ level: "critical", code: "no_channel" });
    // Número que o operador tirou da campanha não é "caído".
    expect(codigos(retrato({ channels: [{ label: "A", status: "WORKING", enabled: true }, { label: "B", status: "STOPPED", enabled: false }] }))).toEqual([]);
  });

  it("campanha pausada diz por quê, e a pausa do sistema não repete o alerta de número", () => {
    expect(calcularAlertas(retrato({ status: "paused", statusReason: "manual" }))).toEqual([expect.objectContaining({ level: "info", code: "campaign_paused" })]);
    const semNumero = calcularAlertas(retrato({ status: "paused", statusReason: "no_channel", channels: [{ label: "A", status: "STOPPED", enabled: true }] }));
    expect(semNumero.map((a) => a.code)).toEqual(["campaign_paused"]);
    expect(semNumero[0]).toMatchObject({ level: "critical", action: "edit_channels" });
    expect(calcularAlertas(retrato({ status: "paused", statusReason: "no_destination" }))[0]).toMatchObject({ level: "warning", action: "switch_destination" });
  });

  it("campanha encerrada ou rascunho não alerta sobre número nem fila", () => {
    for (const status of ["draft", "ready", "completed", "cancelled"] as const) {
      expect(codigos(retrato({ status, channels: [{ label: "A", status: "STOPPED", enabled: true }] })), status).toEqual([]);
    }
  });

  it("taxa de falha só vira alerta com amostra mínima, e escala em dois níveis", () => {
    expect(codigos(retrato({ counts: { pending: 0, sent: 2, failed: 3, uncertain: 0 } }))).toEqual([]);
    expect(AMOSTRA_MINIMA_DE_FALHA).toBe(20);
    expect(calcularAlertas(retrato({ counts: { pending: 0, sent: 90, failed: 10, uncertain: 0 } }))[0]).toMatchObject({ level: "warning", code: "high_failure_rate" });
    expect(calcularAlertas(retrato({ counts: { pending: 0, sent: 60, failed: 40, uncertain: 0 } }))[0]).toMatchObject({ level: "critical", code: "high_failure_rate" });
    expect(codigos(retrato({ counts: { pending: 0, sent: 99, failed: 1, uncertain: 0 } }))).toEqual([]);
  });

  it("envio incerto pede a decisão de uma pessoa", () => {
    const a = calcularAlertas(retrato({ counts: { pending: 5, sent: 10, failed: 0, uncertain: 1 } }));
    expect(a).toEqual([expect.objectContaining({ code: "uncertain_sends", action: "review_uncertain", message: "1 envio ficou incerto e precisa da sua decisão." })]);
    expect(calcularAlertas(retrato({ counts: { pending: 5, sent: 10, failed: 0, uncertain: 4 } }))[0]!.message).toContain("4 envios");
  });

  it("CSV com erros é informativo, e sobe para aviso quando passa de 10% do arquivo", () => {
    expect(calcularAlertas(retrato({ lastImport: { rejected: 67, found: 45000 } }))[0]).toMatchObject({ level: "info", code: "import_rejects", action: "view_import" });
    expect(calcularAlertas(retrato({ lastImport: { rejected: 5000, found: 45000 } }))[0]).toMatchObject({ level: "warning" });
    expect(codigos(retrato({ lastImport: { rejected: 0, found: 100 } }))).toEqual([]);
  });

  it("vem ordenado do mais grave para o menos grave", () => {
    const r = retrato({
      status: "paused",
      statusReason: "manual",
      counts: { pending: 5, sent: 60, failed: 40, uncertain: 0 },
      lastImport: { rejected: 1, found: 100 },
    });
    expect(calcularAlertas(r).map((a) => a.level)).toEqual(["critical", "info", "info"]);
  });
});

describe("estado do contato — onde a pessoa está AGORA", () => {
  const base = { clicked_at: null, replied_at: null, joined_at: null, left_at: null };
  it("do estágio mais avançado para o menos: engajamento não é status", () => {
    expect(estadoDoContato({ status: "sent", ...base })).toBe("ENVIADO");
    expect(estadoDoContato({ status: "sent", ...base, clicked_at: "x" })).toBe("CLICOU");
    expect(estadoDoContato({ status: "sent", ...base, clicked_at: "x", replied_at: "x" })).toBe("RESPONDEU");
    expect(estadoDoContato({ status: "sent", ...base, clicked_at: "x", replied_at: "x", joined_at: "x" })).toBe("NO_GRUPO");
    expect(estadoDoContato({ status: "sent", ...base, clicked_at: "x", joined_at: "x", left_at: "y" })).toBe("SAIU_DO_GRUPO");
  });
  it("quem não foi enviado mostra o estado do envio", () => {
    expect(estadoDoContato({ status: "pending", ...base })).toBe("PENDENTE");
    expect(estadoDoContato({ status: "queued", ...base })).toBe("PENDENTE");
    expect(estadoDoContato({ status: "processing", ...base })).toBe("PROCESSANDO");
    expect(estadoDoContato({ status: "failed", ...base })).toBe("FALHOU");
    expect(estadoDoContato({ status: "uncertain", ...base })).toBe("INCERTO");
    expect(estadoDoContato({ status: "skipped", ...base })).toBe("IGNORADO");
    expect(estadoDoContato({ status: "cancelled", ...base })).toBe("CANCELADO");
  });
});

describe("Fila — linha, busca e filtros", () => {
  it("a linha chega pronta: nome apresentável, telefone formatado, joins objeto ou array", () => {
    const l = linhaDaFila({
      id: "cc", seq: 7, status: "sent", skip_reason: null, sent_at: "2026-09-21T10:00:00Z", updated_at: "2026-09-21T10:00:01Z", attempts: 1, last_error_code: null,
      clicked_at: null, replied_at: null, joined_at: null, left_at: null,
      contact: [{ id: "c1", display_name: "Maria Silva", name: null, phone_number: "+551199998888" }],
      channel: { display_name: null, phone_number: "+5519988887777" },
      version: [{ version_no: 2 }],
      destination: { name: "BLACK #04" },
    });
    expect(l).toMatchObject({ id: "cc", seq: 7, name: "Maria Silva", version_no: 2, destination: "BLACK #04", contact_id: "c1" });
    expect(l.phone).toBe("+5511999998888");
    expect(l.channel).toBe("+5519988887777");
  });

  it("contato sem nome legível não vira identificador técnico; número sem apelido mostra o telefone", () => {
    expect(linhaDaFila({ id: "x", seq: 1, status: "pending", skip_reason: null, sent_at: null, updated_at: "", attempts: 0, last_error_code: null, clicked_at: null, replied_at: null, joined_at: null, left_at: null,
      contact: { id: "c", display_name: "123456@lid", name: null, phone_number: "+5511999998888" }, channel: null, version: null, destination: null }).name).not.toBe("123456@lid");
    expect(rotuloDoNumero({ display_name: "Número 01", phone_number: "+55" })).toBe("Número 01");
    expect(rotuloDoNumero(null)).toBeNull();
  });

  it("a busca só deixa passar o que não quebra a gramática do or= do PostgREST", () => {
    expect(termoDaBusca("Maria Silva")).toEqual({ texto: "Maria*Silva", digitos: "" });
    expect(termoDaBusca("(19) 99999-8888")).toMatchObject({ digitos: "19999998888" });
    expect(termoDaBusca("x),id.gt.0,(y").texto).not.toMatch(/[(),]/);
    expect(termoDaBusca("50%_off\\").texto).not.toMatch(/[%_\\]/);
    expect(termoDaBusca(", ,").texto).toBe("");
    expect(termoDaBusca("João da Conceição").texto).toBe("João*da*Conceição");
  });

  it("filtros: vários status por vírgula, teto de página e tipos estritos", () => {
    const ok = filaQuerySchema.parse({ status: "pending,queued", limit: "50", after: "120", clicked: "true" });
    expect(ok).toMatchObject({ status: ["pending", "queued"], limit: 50, after: 120, clicked: true });
    expect(filaQuerySchema.parse({}).limit).toBe(50);
    expect(filaQuerySchema.parse({}).clicked).toBe(false);
    expect(filaQuerySchema.safeParse({ limit: "1000" }).success).toBe(false);
    expect(filaQuerySchema.safeParse({ status: "sent,voando" }).success).toBe(false);
    expect(filaQuerySchema.safeParse({ channel: "não-uuid" }).success).toBe(false);
    expect(filaQuerySchema.safeParse({ from: "ontem" }).success).toBe(false);
    expect(filaQuerySchema.safeParse({ q: "x".repeat(200) }).success).toBe(false);
  });
});
