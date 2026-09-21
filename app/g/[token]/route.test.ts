// @vitest-environment node
/**
 * O redirecionador público de cliques. O que a rota promete:
 *   - token desconhecido/inválido: 404, e NUNCA redireciona;
 *   - token válido: 302 imediato para o convite, com no-store e sem referrer;
 *   - o clique é registrado DEPOIS da resposta, com a classe certa (pessoa x pré-visualização x robô);
 *   - HEAD nunca registra; falha ao registrar nunca afeta quem clicou;
 *   - destino que não é convite de WhatsApp em https vira 404 (nunca redirecionamento aberto).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  depois: [] as Array<() => unknown>,
}));

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    h.depois.push(fn);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));

import { GET, HEAD } from "@/app/g/[token]/route";

const TOKEN = "9f3a1c0b7d2e4a5b6c7d";
const ALVO = {
  campaign_contact_id: "cc-1",
  campaign_id: "camp-1",
  organization_id: "org-1",
  message_version_id: "v-1",
  destination_id: "d-2",
  from_destination_id: "d-1",
  url: "https://chat.whatsapp.com/BLACK0002",
};
const NAVEGADOR = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const req = (ua: string | null, metodo = "GET") =>
  new NextRequest(`http://localhost/g/${TOKEN}`, { method: metodo, headers: ua ? { "user-agent": ua } : {} });
const params = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const rodarDepois = async () => {
  for (const f of h.depois.splice(0)) await f();
};

beforeEach(() => {
  vi.clearAllMocks();
  h.depois.length = 0;
  h.rpc.mockImplementation(async (fn: string) => (fn === "fn_campaign_click_target" ? { data: ALVO, error: null } : { data: "ok", error: null }));
});

describe("GET /g/<token>", () => {
  it("redireciona NA HORA para o convite, sem guardar cache nem mandar referrer", async () => {
    const res = await GET(req(NAVEGADOR), params());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://chat.whatsapp.com/BLACK0002");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("registra o clique DEPOIS da resposta, como pessoa, com o destino e de onde ele veio", async () => {
    await GET(req(NAVEGADOR), params());
    // Antes de rodar o que ficou para depois, só a resolução do token aconteceu.
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["fn_campaign_click_target"]);
    await rodarDepois();
    expect(h.rpc).toHaveBeenLastCalledWith("fn_campaign_record_click", {
      p_token: TOKEN, p_destination: "d-2", p_from_destination: "d-1", p_agent_class: "browser",
    });
  });

  it("a pré-visualização do WhatsApp e o robô são registrados, mas com a classe deles", async () => {
    await GET(req("WhatsApp/2.24.10.85 A"), params());
    await GET(req("curl/8.4.0"), params());
    await GET(req(null), params());
    await rodarDepois();
    const classes = h.rpc.mock.calls.filter((c) => c[0] === "fn_campaign_record_click").map((c) => (c[1] as { p_agent_class: string }).p_agent_class);
    expect(classes).toEqual(["preview", "bot", "bot"]);
  });

  it("token desconhecido, com formato errado ou sem retorno do banco: 404 e NUNCA redireciona", async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    for (const t of [TOKEN, "abc", "'; drop table campaigns; --"]) {
      const res = await GET(req(NAVEGADOR), params(t));
      expect(res.status, t).toBe(404);
      expect(res.headers.get("location"), t).toBeNull();
    }
    await rodarDepois();
    expect(h.rpc.mock.calls.filter((c) => c[0] === "fn_campaign_record_click")).toHaveLength(0);
  });

  it("erro do banco ao resolver: 404, sem redirecionar", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "conexão caiu" } });
    const res = await GET(req(NAVEGADOR), params());
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("destino que não é convite de WhatsApp em https vira 404 (nunca redirecionamento aberto)", async () => {
    for (const url of ["https://evil.example/phish", "http://chat.whatsapp.com/AbCd1234", "javascript:alert(1)", ""]) {
      h.rpc.mockResolvedValue({ data: { ...ALVO, url }, error: null });
      const res = await GET(req(NAVEGADOR), params());
      expect(res.status, url).toBe(404);
      expect(res.headers.get("location"), url).toBeNull();
    }
  });

  it("falha ao REGISTRAR o clique nunca afeta quem clicou", async () => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "fn_campaign_click_target" ? { data: ALVO, error: null } : { data: null, error: { message: "banco fora" } }));
    const res = await GET(req(NAVEGADOR), params());
    expect(res.status).toBe(302);
    await expect(rodarDepois()).resolves.toBeUndefined();
  });
});

describe("HEAD /g/<token>", () => {
  it("responde como o GET mas NUNCA registra clique", async () => {
    const res = await HEAD(req(NAVEGADOR, "HEAD"), params());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://chat.whatsapp.com/BLACK0002");
    await rodarDepois();
    expect(h.rpc.mock.calls.filter((c) => c[0] === "fn_campaign_record_click")).toHaveLength(0);
  });
});
