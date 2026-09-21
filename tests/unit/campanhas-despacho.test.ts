import { describe, expect, it, vi } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { despachar, type AlvoDoDespacho, type DepsDoDespachante } from "@/lib/campaigns/despachante";
import { linkDoGrupo, type ResultadoDoEnvio } from "@/lib/campaigns/envio";
import { decidirEnvio, knobsDaLinha, type RitmoDoCanal } from "@/lib/campaigns/ritmo";

const SEGUNDA_MEIO_DIA = new Date("2026-09-21T15:00:00Z"); // 12:00 em São Paulo
const SEGUNDA_23H = new Date("2026-09-21T02:00:00Z"); // 23:00 de domingo em São Paulo

const ritmoBase = (o: Partial<RitmoDoCanal["state"]> = {}, extra: Partial<RitmoDoCanal> = {}): RitmoDoCanal => ({
  knobs: { ...PACING_DEFAULTS },
  state: { lastSentAt: null, sentToday: 0, numberActivatedAt: new Date("2025-01-01T00:00:00Z"), ...o },
  crmDailyLimit: 300,
  banRisk: true,
  ...extra,
});
const pedido = (o: Partial<Parameters<typeof decidirEnvio>[1]> = {}) => ({
  agora: SEGUNDA_MEIO_DIA,
  intervaloSegundos: 180,
  capDaCampanha: null,
  enviadosHojePelaCampanha: 0,
  ...o,
});

describe("ritmo — quando um número PODE enviar", () => {
  it("dentro da janela, sem envio recente e sem teto atingido: pode", () => {
    expect(decidirEnvio(ritmoBase(), pedido())).toEqual({ allow: true });
  });

  it("fora da janela de horário não envia, e diz quando reabre", () => {
    const d = decidirEnvio(ritmoBase(), pedido({ agora: SEGUNDA_23H }));
    expect(d).toMatchObject({ allow: false, code: "outside_window" });
    if (!d.allow) expect(d.ate!.getTime()).toBeGreaterThan(SEGUNDA_23H.getTime());
  });

  it("o intervalo entre dois envios do mesmo número é FIXO e escolhido pelo operador", () => {
    const recente = new Date(SEGUNDA_MEIO_DIA.getTime() - 60_000);
    const d = decidirEnvio(ritmoBase({ lastSentAt: recente }), pedido({ intervaloSegundos: 180 }));
    expect(d).toMatchObject({ allow: false, code: "interval" });
    if (!d.allow) expect(d.ate!.getTime()).toBe(recente.getTime() + 180_000);
    const antigo = new Date(SEGUNDA_MEIO_DIA.getTime() - 181_000);
    expect(decidirEnvio(ritmoBase({ lastSentAt: antigo }), pedido({ intervaloSegundos: 180 }))).toEqual({ allow: true });
    // Exatamente no limite já pode.
    expect(decidirEnvio(ritmoBase({ lastSentAt: new Date(SEGUNDA_MEIO_DIA.getTime() - 180_000) }), pedido())).toEqual({ allow: true });
  });

  it("teto diário do número e aquecimento do número novo valem", () => {
    expect(decidirEnvio(ritmoBase({ sentToday: 300 }), pedido())).toMatchObject({ allow: false, code: "daily_cap" });
    expect(decidirEnvio(ritmoBase({ sentToday: 299 }), pedido())).toEqual({ allow: true });
    // Número ativado ontem: o degrau mais conservador do aquecimento manda, bem abaixo dos 300.
    const novo = ritmoBase({ numberActivatedAt: new Date(SEGUNDA_MEIO_DIA.getTime() - 86_400_000), sentToday: 500 });
    expect(decidirEnvio(novo, pedido())).toMatchObject({ allow: false, code: "warmup_cap" });
  });

  it("o teto da CAMPANHA por número é independente do teto do número", () => {
    expect(decidirEnvio(ritmoBase(), pedido({ capDaCampanha: 5, enviadosHojePelaCampanha: 5 }))).toMatchObject({ allow: false, code: "campaign_cap" });
    expect(decidirEnvio(ritmoBase(), pedido({ capDaCampanha: 5, enviadosHojePelaCampanha: 4 }))).toEqual({ allow: true });
    expect(decidirEnvio(ritmoBase(), pedido({ capDaCampanha: null, enviadosHojePelaCampanha: 9999 }))).toEqual({ allow: true });
  });

  it("NÃO usa sorteio nenhum: a mesma entrada dá sempre a mesma resposta, mesmo com jitter configurado no canal", () => {
    const azar = vi.spyOn(Math, "random");
    const comJitter = ritmoBase({}, { knobs: { ...PACING_DEFAULTS, jitterMaxMs: 60_000, throttleMs: 60_000 } });
    const lastSentAt = new Date(SEGUNDA_MEIO_DIA.getTime() - 200_000);
    const resultados = Array.from({ length: 20 }, () => JSON.stringify(decidirEnvio({ ...comJitter, state: { ...comJitter.state, lastSentAt } }, pedido())));
    expect(new Set(resultados).size).toBe(1);
    // Fora da janela a reabertura também é exata (sem "abertura + jitter").
    const fora = Array.from({ length: 20 }, () => JSON.stringify(decidirEnvio(comJitter, pedido({ agora: SEGUNDA_23H }))));
    expect(new Set(fora).size).toBe(1);
    expect(azar).not.toHaveBeenCalled();
    azar.mockRestore();
  });

  it("canal sem risco de banimento ignora aquecimento e teto, mas janela e intervalo continuam", () => {
    const oficial = ritmoBase({ sentToday: 99999 }, { banRisk: false });
    expect(decidirEnvio(oficial, pedido())).toEqual({ allow: true });
    expect(decidirEnvio(oficial, pedido({ agora: SEGUNDA_23H }))).toMatchObject({ code: "outside_window" });
    const recente = ritmoBase({ lastSentAt: new Date(SEGUNDA_MEIO_DIA.getTime() - 10_000) }, { banRisk: false });
    expect(decidirEnvio(recente, pedido())).toMatchObject({ code: "interval" });
  });

  it("knobs: a linha do canal vale, e aquecimento inválido cai nos degraus conservadores (nunca em 'sem teto')", () => {
    expect(knobsDaLinha(null).knobs).toEqual(PACING_DEFAULTS);
    const { knobs, ativadoEm } = knobsDaLinha({
      throttle_ms: null,
      jitter_max_ms: null,
      window_start_hour: 9,
      window_end_hour: 18,
      allow_sunday: false,
      timezone: "America/Sao_Paulo",
      warmup_daily_caps: "lixo",
      number_activated_at: "2026-01-01T00:00:00Z",
    });
    expect(knobs).toMatchObject({ windowStartHour: 9, windowEndHour: 18, allowSunday: false });
    expect(knobs.warmupDailyCaps).toEqual(PACING_DEFAULTS.warmupDailyCaps);
    expect(ativadoEm).toEqual(new Date("2026-01-01T00:00:00Z"));
  });
});

describe("linkDoGrupo — o link vem do destino, nunca do texto", () => {
  const base = { token: "abc123", destinationUrl: "https://chat.whatsapp.com/BLACK04" };
  it("rastreio ligado e base pública: o redirecionador; senão o convite cru", () => {
    expect(linkDoGrupo({ ...base, trackingEnabled: true, baseUrl: "https://crm.exemplo.test/" })).toBe("https://crm.exemplo.test/g/abc123");
    expect(linkDoGrupo({ ...base, trackingEnabled: true, baseUrl: null })).toBe("https://chat.whatsapp.com/BLACK04");
    expect(linkDoGrupo({ ...base, trackingEnabled: false, baseUrl: "https://crm.exemplo.test" })).toBe("https://chat.whatsapp.com/BLACK04");
    expect(linkDoGrupo({ ...base, destinationUrl: null, trackingEnabled: true, baseUrl: "https://x.test" })).toBeNull();
  });
});

// ── o despachante inteiro, sem banco e sem WhatsApp ─────────────────────────

const ORG = "b7c30000-0000-4000-8000-000000000001";
const alvo = (o: Partial<AlvoDoDespacho> = {}): AlvoDoDespacho => ({
  organization_id: ORG,
  campaign_id: "camp-1",
  channel_session_id: "canal-1",
  channel_status: "WORKING",
  channel_archived: false,
  channel_provider: "waha",
  daily_message_limit: 300,
  channel_policy: "skip_channel",
  tracking_enabled: true,
  send_interval_seconds: 180,
  daily_cap_per_channel: null,
  started_at: "2026-09-21T10:00:00Z",
  ...o,
});
const reserva = (n = 1) => ({ campaign_contact_id: `cc-${n}`, contact_id: `contato-${n}`, claim_token: `tok-${n}` });
const decisaoDeEnvio = (o: Record<string, unknown> = {}) => ({
  decision: "send",
  body: "Oi {{primeiro_nome}}! Entre: {{link_grupo}}",
  destination_url: "https://chat.whatsapp.com/BLACK04",
  tracking_enabled: false,
  tracking_token: "tk1",
  variables: {},
  ...o,
});

type Rpc = Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;

function montar(rpcs: Rpc = {}, o: Partial<DepsDoDespachante> = {}) {
  const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const padrao: Rpc = {
    fn_campaign_sweep_leases: { released: 0, uncertain: 0 },
    fn_campaign_dispatch_targets: [alvo()],
    fn_campaign_claim_batch: [reserva()],
    fn_campaign_begin_send: decisaoDeEnvio(),
    fn_campaign_mark_sent: "ok",
    fn_campaign_mark_failed: "failed",
    fn_campaign_mark_uncertain: "ok",
    fn_campaign_complete_if_done: false,
    fn_campaign_transition: { changed: true },
  };
  const tabela = { ...padrao, ...rpcs };
  const enviarTexto = vi.fn<DepsDoDespachante["enviarTexto"]>(async () => ({ messageId: "msg-1", externalId: "ext-1", status: "sent" }));
  const registrarEnvio = vi.fn(async () => undefined);
  const auditarPausa = vi.fn();
  const deps: DepsDoDespachante = {
    async chamar<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      chamadas.push({ fn, args });
      const v = tabela[fn];
      return (typeof v === "function" ? (v as (a: Record<string, unknown>) => unknown)(args) : v) as T;
    },
    agora: () => SEGUNDA_MEIO_DIA,
    ritmoDoCanal: async () => ritmoBase(),
    enviadosHojePelaCampanha: async () => 0,
    nomeDoContato: async () => "Maria Silva",
    enviarTexto,
    registrarEnvio,
    baseDoRastreio: null,
    auditarPausa,
    log: () => undefined,
    ...o,
  };
  const feitas = (fn: string) => chamadas.filter((c) => c.fn === fn);
  return { deps, chamadas, feitas, enviarTexto, registrarEnvio, auditarPausa };
}

describe("despachante — um envio", () => {
  it("reserva UM contato, passa pelo ponto sem volta, envia o texto renderizado e registra o desfecho", async () => {
    const t = montar();
    const r = await despachar(t.deps);
    expect(r).toMatchObject({ enviados: 1, falhas: 0, incertos: 0, alvos: 1 });
    expect(t.feitas("fn_campaign_claim_batch")[0]!.args).toMatchObject({ p_limit: 1, p_exclusive: true, p_channel: "canal-1", p_campaign: "camp-1" });
    expect(t.feitas("fn_campaign_begin_send")[0]!.args).toMatchObject({ p_campaign_contact: "cc-1", p_claim_token: "tok-1" });
    expect(t.enviarTexto).toHaveBeenCalledWith(expect.objectContaining({ texto: "Oi Maria! Entre: https://chat.whatsapp.com/BLACK04", channelId: "canal-1", contactId: "contato-1", campaignContactId: "cc-1" }));
    expect(t.feitas("fn_campaign_mark_sent")[0]!.args).toMatchObject({ p_message_id: "msg-1", p_external_id: "ext-1", p_claim_token: "tok-1" });
    expect(t.registrarEnvio).toHaveBeenCalledWith(ORG, "canal-1", SEGUNDA_MEIO_DIA);
    // A ORDEM é o que impede duplicar: reserva -> begin -> (envia) -> mark.
    const ordem = t.chamadas.map((c) => c.fn).filter((f) => ["fn_campaign_claim_batch", "fn_campaign_begin_send", "fn_campaign_mark_sent"].includes(f));
    expect(ordem).toEqual(["fn_campaign_claim_batch", "fn_campaign_begin_send", "fn_campaign_mark_sent"]);
  });

  it("com rastreio ligado e base pública, o link da mensagem é o redirecionador do contato", async () => {
    const t = montar({ fn_campaign_begin_send: decisaoDeEnvio({ tracking_enabled: true, tracking_token: "tk9" }) }, { baseDoRastreio: "https://crm.exemplo.test" });
    await despachar(t.deps);
    expect(t.enviarTexto.mock.calls[0]![0].texto).toContain("https://crm.exemplo.test/g/tk9");
  });

  it("colunas do CSV entram no texto; variável SEM valor não é enviada — o contato falha com o motivo", async () => {
    const ok = montar({ fn_campaign_begin_send: decisaoDeEnvio({ body: "{{produto}} para {{nome}}", variables: { produto: "Tênis" } }) });
    await despachar(ok.deps);
    expect(ok.enviarTexto.mock.calls[0]![0].texto).toBe("Tênis para Maria Silva");

    const sem = montar({ fn_campaign_begin_send: decisaoDeEnvio({ body: "{{produto}} para {{nome}}", variables: {} }) });
    const r = await despachar(sem.deps);
    expect(sem.enviarTexto).not.toHaveBeenCalled();
    expect(sem.feitas("fn_campaign_mark_failed")[0]!.args).toMatchObject({ p_error_code: "missing_variable", p_retryable: false });
    expect(sem.feitas("fn_campaign_mark_failed")[0]!.args.p_error).toContain("produto");
    expect(r.falhas).toBe(1);
  });

  it("contato sem nome legível não recebe 'Oi {{nome}}' quebrado", async () => {
    const t = montar({}, { nomeDoContato: async () => null });
    await despachar(t.deps);
    expect(t.enviarTexto).not.toHaveBeenCalled();
    expect(t.feitas("fn_campaign_mark_failed")[0]!.args.p_error_code).toBe("missing_variable");
  });
});

describe("despachante — o que NUNCA vira envio duplo", () => {
  it("o envio lançou erro: fica INCERTO, nunca volta para a fila nem é reenviado", async () => {
    const t = montar();
    t.enviarTexto.mockRejectedValueOnce(new Error("socket hang up"));
    const r = await despachar(t.deps);
    expect(r).toMatchObject({ incertos: 1, enviados: 0 });
    expect(t.feitas("fn_campaign_mark_uncertain")).toHaveLength(1);
    expect(t.feitas("fn_campaign_mark_failed")).toHaveLength(0);
    expect(t.feitas("fn_campaign_mark_sent")).toHaveLength(0);
    expect(t.enviarTexto).toHaveBeenCalledTimes(1);
  });

  it("o canal recusou a mensagem: falha DEFINITIVA (não retenta por conta própria)", async () => {
    const t = montar();
    t.enviarTexto.mockResolvedValueOnce({ messageId: "m", externalId: null, status: "failed", errorCode: "send_failed", errorMessage: "recusado" } satisfies ResultadoDoEnvio);
    const r = await despachar(t.deps);
    expect(r.falhas).toBe(1);
    expect(t.feitas("fn_campaign_mark_failed")[0]!.args).toMatchObject({ p_error_code: "send_failed", p_retryable: false });
  });

  it("o número não estava pronto (nada saiu): falha RETENTÁVEL, com teto de tentativas", async () => {
    const t = montar();
    t.enviarTexto.mockResolvedValueOnce({ messageId: "m", externalId: null, status: "queued" });
    await despachar(t.deps);
    expect(t.feitas("fn_campaign_mark_failed")[0]!.args).toMatchObject({ p_error_code: "channel_not_ready", p_retryable: true, p_max_attempts: 5 });
  });

  it("a reserva foi perdida ou já é de outro worker: não envia nada", async () => {
    for (const decision of ["lost", "already_processing", "released", "channel_unavailable", "skipped"]) {
      const t = montar({ fn_campaign_begin_send: { decision } });
      const r = await despachar(t.deps);
      expect(t.enviarTexto, decision).not.toHaveBeenCalled();
      expect(r.enviados, decision).toBe(0);
      expect(r.motivos[`begin_${decision}`], decision).toBe(1);
    }
  });

  it("uma rodada manda no máximo UM contato por número, mesmo com duas campanhas nele", async () => {
    const t = montar({
      fn_campaign_dispatch_targets: [alvo({ campaign_id: "A", started_at: "2026-09-21T09:00:00Z" }), alvo({ campaign_id: "B", started_at: "2026-09-21T10:00:00Z" })],
    });
    const r = await despachar(t.deps);
    expect(r.enviados).toBe(1);
    expect(t.feitas("fn_campaign_claim_batch")).toHaveLength(1);
    // Quem começou antes é servida primeiro.
    expect(t.feitas("fn_campaign_claim_batch")[0]!.args.p_campaign).toBe("A");
  });

  it("se a campanha mais antiga não tem pendente, a seguinte é atendida", async () => {
    let n = 0;
    const t = montar({
      fn_campaign_dispatch_targets: [alvo({ campaign_id: "A" }), alvo({ campaign_id: "B" })],
      fn_campaign_claim_batch: () => (++n === 1 ? [] : [reserva()]),
    });
    const r = await despachar(t.deps);
    expect(r.enviados).toBe(1);
    expect(t.feitas("fn_campaign_claim_batch").map((c) => c.args.p_campaign)).toEqual(["A", "B"]);
  });

  it("o teto por dia de uma campanha não impede a outra de enviar pelo mesmo número", async () => {
    const t = montar(
      { fn_campaign_dispatch_targets: [alvo({ campaign_id: "A", daily_cap_per_channel: 3 }), alvo({ campaign_id: "B" })] },
      { enviadosHojePelaCampanha: async (a) => (a.campaign_id === "A" ? 3 : 0) },
    );
    const r = await despachar(t.deps);
    expect(r.motivos.campaign_cap).toBe(1);
    expect(t.feitas("fn_campaign_claim_batch").map((c) => c.args.p_campaign)).toEqual(["B"]);
    expect(r.enviados).toBe(1);
  });
});

describe("despachante — ritmo e número caído", () => {
  it("ritmo veta: nada é reservado, e o motivo aparece no resumo", async () => {
    const t = montar({}, { ritmoDoCanal: async () => ritmoBase({ sentToday: 300 }) });
    const r = await despachar(t.deps);
    expect(t.feitas("fn_campaign_claim_batch")).toHaveLength(0);
    expect(r.motivos.daily_cap).toBe(1);
  });

  it("a rodada varre as leases vencidas ANTES de reservar", async () => {
    const t = montar({ fn_campaign_sweep_leases: { released: 2, uncertain: 1 } });
    const r = await despachar(t.deps);
    expect(r.varridos).toEqual({ released: 2, uncertain: 1 });
    expect(t.chamadas[0]!.fn).toBe("fn_campaign_sweep_leases");
  });

  it("todos os números caídos: a campanha PAUSA (a fila fica intacta) e é auditada uma vez", async () => {
    const t = montar({ fn_campaign_dispatch_targets: [alvo({ channel_status: "STOPPED" })] });
    const r = await despachar(t.deps);
    expect(r.pausadas).toBe(1);
    expect(t.feitas("fn_campaign_transition")[0]!.args).toMatchObject({ p_action: "pause", p_reason: "no_channel", p_actor: null });
    expect(t.auditarPausa).toHaveBeenCalledTimes(1);
    expect(t.auditarPausa).toHaveBeenCalledWith(ORG, "camp-1", "no_channel");
    expect(t.feitas("fn_campaign_claim_batch")).toHaveLength(0);
  });

  it("número arquivado conta como caído", async () => {
    const t = montar({ fn_campaign_dispatch_targets: [alvo({ channel_archived: true })] });
    expect((await despachar(t.deps)).pausadas).toBe(1);
  });

  it("política 'seguir com os outros': um número caído não para a campanha", async () => {
    const t = montar({ fn_campaign_dispatch_targets: [alvo({ channel_session_id: "caido", channel_status: "STOPPED" }), alvo({ channel_session_id: "vivo" })] });
    const r = await despachar(t.deps);
    expect(r.pausadas).toBe(0);
    expect(t.feitas("fn_campaign_claim_batch").map((c) => c.args.p_channel)).toEqual(["vivo"]);
    expect(r.enviados).toBe(1);
  });

  it("política 'pausar tudo': um número caído pausa a campanha inteira", async () => {
    const t = montar({
      fn_campaign_dispatch_targets: [
        alvo({ channel_session_id: "caido", channel_status: "STOPPED", channel_policy: "pause_campaign" }),
        alvo({ channel_session_id: "vivo", channel_policy: "pause_campaign" }),
      ],
    });
    const r = await despachar(t.deps);
    expect(r.pausadas).toBe(1);
    expect(t.feitas("fn_campaign_transition")[0]!.args.p_reason).toBe("channel_down");
    expect(t.feitas("fn_campaign_claim_batch")).toHaveLength(0);
  });

  it("pausa que não mudou nada (já estava pausada) não audita", async () => {
    const t = montar({ fn_campaign_dispatch_targets: [alvo({ channel_status: "STOPPED" })], fn_campaign_transition: { changed: false } });
    await despachar(t.deps);
    expect(t.auditarPausa).not.toHaveBeenCalled();
  });

  it("mensagem com {{link_grupo}} sem destino ativo: devolve o contato à fila e PAUSA a campanha", async () => {
    const t = montar({ fn_campaign_begin_send: { decision: "no_destination" } });
    const r = await despachar(t.deps);
    expect(t.enviarTexto).not.toHaveBeenCalled();
    expect(t.feitas("fn_campaign_transition")[0]!.args).toMatchObject({ p_action: "pause", p_reason: "no_destination" });
    expect(r.motivos.begin_no_destination).toBe(1);
  });

  it("um número que dá erro não derruba a rodada dos outros", async () => {
    const t = montar(
      { fn_campaign_dispatch_targets: [alvo({ channel_session_id: "quebrado" }), alvo({ channel_session_id: "bom" })] },
      {
        ritmoDoCanal: async (a) => {
          if (a.channel_session_id === "quebrado") throw new Error("banco fora");
          return ritmoBase();
        },
      },
    );
    const r = await despachar(t.deps);
    expect(r.enviados).toBe(1);
    expect(r.motivos.erro_no_numero).toBe(1);
  });

  it("campanha sem mais nada por processar se encerra sozinha", async () => {
    const t = montar({ fn_campaign_claim_batch: [], fn_campaign_complete_if_done: true });
    const r = await despachar(t.deps);
    expect(r.concluidas).toBe(1);
    expect(r.motivos.sem_pendente).toBe(1);
    expect(t.feitas("fn_campaign_complete_if_done")[0]!.args).toMatchObject({ p_org: ORG, p_campaign: "camp-1" });
  });

  it("campanha pausada nesta rodada não é dada como concluída", async () => {
    const t = montar({ fn_campaign_dispatch_targets: [alvo({ channel_status: "STOPPED" })], fn_campaign_complete_if_done: true });
    expect((await despachar(t.deps)).concluidas).toBe(0);
    expect(t.feitas("fn_campaign_complete_if_done")).toHaveLength(0);
  });

  it("falhar em registrar o envio no ledger nunca desfaz o envio", async () => {
    const t = montar();
    t.registrarEnvio.mockRejectedValueOnce(new Error("ledger fora"));
    const r = await despachar(t.deps);
    expect(r.enviados).toBe(1);
  });

  it("sem nenhuma campanha rodando não faz nada além de varrer", async () => {
    const t = montar({ fn_campaign_dispatch_targets: [] });
    const r = await despachar(t.deps);
    expect(r).toMatchObject({ alvos: 0, enviados: 0 });
    expect(t.chamadas.map((c) => c.fn)).toEqual(["fn_campaign_sweep_leases", "fn_campaign_dispatch_targets"]);
  });
});
