/**
 * A ponte de envio da campanha: sai pelo MESMO caminho do Inbox (`sendMessageHandler`), cria
 * a conversa de forma que ela fique escondida até a pessoa responder — mas só se a conversa
 * for NOVA — e traduz o desfecho do envio para o que o despachante entende.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ensureConversation: vi.fn(),
  sendMessageHandler: vi.fn(),
}));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: h.ensureConversation }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: h.sendMessageHandler }));

import { enviarTextoPelaCentral } from "@/lib/campaigns/envio";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const envio = {
  orgId: ORG,
  contactId: "contato-1",
  channelId: "canal-1",
  campaignId: "camp-1",
  campaignContactId: "cc-1",
  texto: "Oi Maria",
};

interface Fake {
  conversa: { last_message_at: string | null; metadata: Record<string, unknown> | null } | null;
  atualizacoes: Array<{ tabela: string; valores: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
}

function fakeAdmin(f: Fake) {
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      const cadeia = {
        select: () => cadeia,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return cadeia;
        },
        maybeSingle: async () => ({ data: f.conversa, error: null }),
        update: (valores: Record<string, unknown>) => {
          const u = { tabela, valores, filtros };
          f.atualizacoes.push(u);
          return cadeia;
        },
      };
      return cadeia;
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ensureConversation.mockResolvedValue("conv-1");
  h.sendMessageHandler.mockResolvedValue({ id: "msg-1", status: "sent", external_id: "ext-1", error_code: null, error_message: null });
});

describe("enviarTextoPelaCentral", () => {
  it("envia pelo caminho único do CRM, com o ator de worker e a linha da campanha como referência", async () => {
    const f: Fake = { conversa: { last_message_at: "2026-09-01T10:00:00Z", metadata: {} }, atualizacoes: [] };
    const r = await enviarTextoPelaCentral(fakeAdmin(f))(envio);
    expect(h.ensureConversation).toHaveBeenCalledWith(expect.anything(), ORG, "contato-1", "canal-1");
    expect(h.sendMessageHandler).toHaveBeenCalledWith(
      expect.anything(),
      { organization_id: ORG, actor: { type: "webhook_source", id: "cc-1" }, requestId: "campaign:cc-1" },
      { conversation_id: "conv-1", type: "text", body: "Oi Maria" },
    );
    expect(r).toEqual({ messageId: "msg-1", externalId: "ext-1", status: "sent" });
  });

  it("conversa NOVA (sem nenhuma mensagem) nasce escondida até a pessoa responder, preservando o metadata", async () => {
    const f: Fake = { conversa: { last_message_at: null, metadata: { origem: "x" } }, atualizacoes: [] };
    await enviarTextoPelaCentral(fakeAdmin(f))(envio);
    const marca = f.atualizacoes.find((a) => a.tabela === "conversations")!;
    expect(marca.valores).toEqual({ metadata: { origem: "x", campaign: { id: "camp-1", hidden_until_reply: true } } });
    expect(marca.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("conversa que JÁ EXISTIA (cliente que já conversava com a equipe) nunca é escondida", async () => {
    const f: Fake = { conversa: { last_message_at: "2026-09-20T09:00:00Z", metadata: {} }, atualizacoes: [] };
    await enviarTextoPelaCentral(fakeAdmin(f))(envio);
    expect(f.atualizacoes.filter((a) => a.tabela === "conversations")).toHaveLength(0);
  });

  it("o canal recusou: devolve o código e a mensagem do canal, sem mexer na linha", async () => {
    h.sendMessageHandler.mockResolvedValue({ id: "msg-2", status: "failed", external_id: null, error_code: "send_failed", error_message: "recusado" });
    const f: Fake = { conversa: { last_message_at: "x", metadata: null }, atualizacoes: [] };
    expect(await enviarTextoPelaCentral(fakeAdmin(f))(envio)).toEqual({
      messageId: "msg-2", externalId: null, status: "failed", errorCode: "send_failed", errorMessage: "recusado",
    });
    expect(f.atualizacoes.filter((a) => a.tabela === "messages")).toHaveLength(0);
  });

  it("o número não estava pronto (queued): nada saiu, e a linha pendurada é marcada como falha para ninguém enviá-la depois", async () => {
    h.sendMessageHandler.mockResolvedValue({ id: "msg-3", status: "queued", external_id: null, error_code: null, error_message: null });
    const f: Fake = { conversa: { last_message_at: "x", metadata: null }, atualizacoes: [] };
    const r = await enviarTextoPelaCentral(fakeAdmin(f))(envio);
    expect(r.status).toBe("queued");
    const msg = f.atualizacoes.find((a) => a.tabela === "messages")!;
    expect(msg.valores).toMatchObject({ status: "failed", error_code: "campaign_not_sent" });
    expect(msg.filtros).toContainEqual(["id", "msg-3"]);
    expect(msg.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("entregue e lida contam como enviadas", async () => {
    for (const status of ["delivered", "read"]) {
      h.sendMessageHandler.mockResolvedValue({ id: "m", status, external_id: "e", error_code: null, error_message: null });
      const f: Fake = { conversa: { last_message_at: "x", metadata: null }, atualizacoes: [] };
      expect((await enviarTextoPelaCentral(fakeAdmin(f))(envio)).status, status).toBe("sent");
    }
  });

  it("erro do envio PROPAGA (o despachante decide que fica incerto): a ponte não engole nem reenvia", async () => {
    h.sendMessageHandler.mockRejectedValue(new Error("boom"));
    const f: Fake = { conversa: { last_message_at: "x", metadata: null }, atualizacoes: [] };
    await expect(enviarTextoPelaCentral(fakeAdmin(f))(envio)).rejects.toThrow("boom");
    expect(h.sendMessageHandler).toHaveBeenCalledTimes(1);
  });
});
