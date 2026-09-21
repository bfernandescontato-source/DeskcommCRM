/**
 * A ponte de envio da campanha: sai pelo MESMO caminho do Inbox (`sendMessageHandler`), abre a
 * conversa pela função do banco (nova = arquivada; existente = intocada) e traduz o desfecho do
 * envio para o que o despachante entende.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sendMessageHandler: vi.fn(),
}));
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
  aberta: { data: { conversation_id: string; created: boolean } | null; error: { message: string } | null };
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  atualizacoes: Array<{ tabela: string; valores: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
}

const novoFake = (): Fake => ({ aberta: { data: { conversation_id: "conv-1", created: true }, error: null }, rpcs: [], atualizacoes: [] });

function fakeAdmin(f: Fake) {
  return {
    async rpc(fn: string, args: Record<string, unknown>) {
      f.rpcs.push({ fn, args });
      return f.aberta;
    },
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      const cadeia = {
        update: (valores: Record<string, unknown>) => {
          f.atualizacoes.push({ tabela, valores, filtros });
          return cadeia;
        },
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return cadeia;
        },
      };
      return cadeia;
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sendMessageHandler.mockResolvedValue({ id: "msg-1", status: "sent", external_id: "ext-1", error_code: null, error_message: null });
});

describe("enviarTextoPelaCentral", () => {
  it("abre a conversa pela função da campanha (nunca por ensureConversation) e envia pelo caminho único do CRM", async () => {
    const f = novoFake();
    const r = await enviarTextoPelaCentral(fakeAdmin(f))(envio);
    expect(f.rpcs).toEqual([{ fn: "fn_campaign_open_conversation", args: { p_org: ORG, p_contact: "contato-1", p_channel: "canal-1" } }]);
    expect(h.sendMessageHandler).toHaveBeenCalledWith(
      expect.anything(),
      { organization_id: ORG, actor: { type: "webhook_source", id: "cc-1" }, requestId: "campaign:cc-1" },
      { conversation_id: "conv-1", type: "text", body: "Oi Maria", metadata: { campaign_id: "camp-1", campaign_contact_id: "cc-1" } },
    );
    expect(r).toEqual({ messageId: "msg-1", externalId: "ext-1", status: "sent" });
  });

  it("não mexe em conversa nenhuma por conta própria: o que arquiva ou preserva é a função do banco", async () => {
    const f = novoFake();
    await enviarTextoPelaCentral(fakeAdmin(f))(envio);
    expect(f.atualizacoes.filter((a) => a.tabela === "conversations")).toHaveLength(0);
  });

  it("não envia nada se a conversa não pôde ser aberta (contato anonimizado, canal arquivado…)", async () => {
    const f = novoFake();
    f.aberta = { data: null, error: { message: "campaign_contact_unavailable" } };
    await expect(enviarTextoPelaCentral(fakeAdmin(f))(envio)).rejects.toThrow("campaign_contact_unavailable");
    expect(h.sendMessageHandler).not.toHaveBeenCalled();
  });

  it("o canal recusou: devolve o código e a mensagem do canal, sem mexer na linha", async () => {
    h.sendMessageHandler.mockResolvedValue({ id: "msg-2", status: "failed", external_id: null, error_code: "send_failed", error_message: "recusado" });
    const f = novoFake();
    expect(await enviarTextoPelaCentral(fakeAdmin(f))(envio)).toEqual({
      messageId: "msg-2", externalId: null, status: "failed", errorCode: "send_failed", errorMessage: "recusado",
    });
    expect(f.atualizacoes.filter((a) => a.tabela === "messages")).toHaveLength(0);
  });

  it("o número não estava pronto (queued): nada saiu, e a linha pendurada é marcada como falha para ninguém enviá-la depois", async () => {
    h.sendMessageHandler.mockResolvedValue({ id: "msg-3", status: "queued", external_id: null, error_code: null, error_message: null });
    const f = novoFake();
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
      expect((await enviarTextoPelaCentral(fakeAdmin(novoFake()))(envio)).status, status).toBe("sent");
    }
  });

  it("erro do envio PROPAGA (o despachante decide que fica incerto): a ponte não engole nem reenvia", async () => {
    h.sendMessageHandler.mockRejectedValue(new Error("boom"));
    await expect(enviarTextoPelaCentral(fakeAdmin(novoFake()))(envio)).rejects.toThrow("boom");
    expect(h.sendMessageHandler).toHaveBeenCalledTimes(1);
  });
});
