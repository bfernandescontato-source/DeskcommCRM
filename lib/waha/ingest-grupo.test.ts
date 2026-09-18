import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn() }));
vi.mock("@/lib/waha/client", async (original) => ({
  ...(await original<typeof import("@/lib/waha/client")>()),
  getWahaClient: vi.fn(),
}));

import { dispatchWahaEvent, limparCacheDoNomeDoGrupo, parseChatId, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { getWahaClient } from "@/lib/waha/client";

/**
 * GRUPO VIRA CONVERSA (migration 0276), MAS NUNCA "DEAL INFINITO".
 *
 * Antes desta mudança, `handleInbound` descartava toda mensagem de grupo
 * (`kind === "group") return`). A migration 0027 tinha matado o "deal
 * infinito" (um lead por remetente) para o caso 1-para-1; reabrir grupo sem
 * cuidado reabriria o MESMO problema, só que pior — um grupo tem N
 * participantes, cada mensagem de uma pessoa diferente.
 *
 * A prova aqui é a identidade: o contato-fantasma nasce do CHAT ID DO GRUPO
 * (`fn_upsert_wa_group_contact`), nunca de quem fala (`p.author`) — duas
 * mensagens do mesmo grupo, remetentes diferentes, têm que pedir o upsert com
 * o MESMO `p_chat_id`, e a RPC (não simulada aqui — é o `on conflict` da
 * migration 0276) garante que vira uma única linha.
 *
 * A segunda garantia: mensagem de grupo nunca acorda lead nem IA.
 * `aplicarEfeitosPosEntrada` é a porta única para os dois (opt-out, nascimento
 * de lead e despacho do agente) — se esta função for chamada para grupo, a
 * regra de negócio W-09 quebrou.
 */

interface Duplo {
  admin: unknown;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  messages: Array<Record<string, unknown>>;
}

function bancoDeMentira(): Duplo {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const messages: Array<Record<string, unknown>> = [];
  const consulta = () => {
    const q = {
      eq: () => q,
      in: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return q;
  };
  const consultaDaSessao = () => {
    const q = {
      eq: () => q,
      maybeSingle: async () => ({ data: { waha_session_name: "org_x_sessao" }, error: null }),
    };
    return q;
  };
  const admin = {
    from: (tabela: string) => ({
      select: () => (tabela === "channel_sessions" ? consultaDaSessao() : consulta()),
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          maybeSingle: async () => {
            messages.push(linha);
            return { data: { id: `msg-${messages.length}` }, error: null };
          },
        }),
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_group_contact") return { data: "grupo-fantasma-1", error: null };
      if (fn === "fn_upsert_wa_group_conversation") return { data: "conversa-grupo-1", error: null };
      return { data: null, error: null };
    },
  };
  return { admin, rpcs, messages };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };
const GRUPO = "120363000000000000@g.us";

function inboundDeGrupo(author: string, msgId: string, quemEscreveu?: string): WahaEnvelope {
  const payload: WahaPayload = {
    id: msgId,
    from: GRUPO,
    author,
    fromMe: false,
    body: "oi pessoal",
    ...(quemEscreveu ? { _data: { notifyName: quemEscreveu } } : {}),
  };
  return { event: "message.any", session: "default", payload };
}

beforeEach(() => {
  limparCacheDoNomeDoGrupo();
  vi.mocked(getWahaClient).mockReset();
});

function wahaComNome(nome: string | null) {
  const getGroupSubject = vi.fn(async () => nome);
  vi.mocked(getWahaClient).mockReturnValue({ getGroupSubject } as never);
  return getGroupSubject;
}

describe("parseChatId classifica grupo, mas ingest não descarta mais", () => {
  it("@g.us continua kind=group — só o QUE ACONTECE DEPOIS mudou", () => {
    expect(parseChatId(GRUPO)).toEqual({ kind: "group", phone: null, lid: null });
  });
});

describe("contato-fantasma é por GRUPO, não por participante", () => {
  it("duas pessoas diferentes no mesmo grupo pedem upsert com o MESMO chat id", async () => {
    const { admin, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_1"), "req-1");
    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5522222222222@s.whatsapp.net", "false_g_2"), "req-2");

    const chamadas = rpcs.filter((c) => c.fn === "fn_upsert_wa_group_contact");
    expect(chamadas).toHaveLength(2);
    expect(chamadas[0].args.p_chat_id).toBe(GRUPO);
    expect(chamadas[1].args.p_chat_id).toBe(GRUPO);
    // A identidade do grupo não carrega quem falou — só o chat.
    expect(chamadas.map((c) => c.args.p_chat_id)).toEqual([GRUPO, GRUPO]);
  });

  it("nunca chama fn_upsert_wa_contact (o de pessoa) para mensagem de grupo", async () => {
    const { admin, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_3"), "req-1");

    expect(rpcs.some((c) => c.fn === "fn_upsert_wa_contact")).toBe(false);
  });

  it("a conversa nasce com fn_upsert_wa_group_conversation, ligada ao MESMO grupo", async () => {
    const { admin, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_4"), "req-1");

    const conv = rpcs.find((c) => c.fn === "fn_upsert_wa_group_conversation");
    expect(conv?.args.p_group_chat_id).toBe(GRUPO);
    expect(conv?.args.p_contact).toBe("grupo-fantasma-1");
  });

  it("a mensagem grava quem falou (p.author) em metadata, sem virar a identidade da conversa", async () => {
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_5"), "req-1");

    expect(messages).toHaveLength(1);
    const meta = messages[0].metadata as Record<string, unknown>;
    expect(meta.is_group).toBe(true);
    expect(meta.group_participant).toBe("5511111111111@s.whatsapp.net");
  });
});

describe("mensagem de grupo nunca acorda lead nem IA (regra W-09, regra dura nº 12)", () => {
  it("aplicarEfeitosPosEntrada NUNCA é chamado para mensagem de grupo", async () => {
    const { admin } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_6"), "req-1");

    expect(
      aplicarEfeitosPosEntrada,
      "grupo chamou o mesmo caminho que cria lead/despacha IA para o 1-para-1",
    ).not.toHaveBeenCalled();
  });
});

describe("o NOME do grupo vem do WAHA, nunca de quem escreveu", () => {
  it("usa o subject do grupo e ignora o nome da pessoa que falou", async () => {
    const buscar = wahaComNome("Achados & Promoções #37");
    const { admin, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_n1", "Diana Diniz"), "req-1");

    const chamada = rpcs.find((c) => c.fn === "fn_upsert_wa_group_contact")!;
    expect(chamada.args.p_subject).toBe("Achados & Promoções #37");
    expect(JSON.stringify(rpcs), "o nome da pessoa vazou para o nome do grupo").not.toContain("Diana Diniz");
    expect(buscar).toHaveBeenCalledWith("org_x_sessao", GRUPO);
  });

  it("busca o nome UMA vez por grupo, não a cada mensagem", async () => {
    const buscar = wahaComNome("Grupo Certo");
    const { admin, rpcs } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_n2"), "req-1");
    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5522222222222@s.whatsapp.net", "false_g_n3"), "req-2");

    expect(buscar).toHaveBeenCalledTimes(1);
    const assuntos = rpcs.filter((c) => c.fn === "fn_upsert_wa_group_contact").map((c) => c.args.p_subject);
    // A 2ª mensagem manda null: "não mexa no nome que já existe".
    expect(assuntos).toEqual(["Grupo Certo", null]);
  });

  it("WAHA sem resposta: a mensagem entra e o nome existente é preservado (null)", async () => {
    wahaComNome(null);
    const { admin, rpcs, messages } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_n4", "Diana Diniz"), "req-1");

    expect(messages).toHaveLength(1);
    expect(rpcs.find((c) => c.fn === "fn_upsert_wa_group_contact")!.args.p_subject).toBeNull();
  });

  it("sem cliente WAHA configurado, a mensagem também entra", async () => {
    vi.mocked(getWahaClient).mockReturnValue(null);
    const { admin, messages } = bancoDeMentira();

    await dispatchWahaEvent(admin as never, SESSION as never, inboundDeGrupo("5511111111111@s.whatsapp.net", "false_g_n5"), "req-1");

    expect(messages).toHaveLength(1);
  });
});
