// @vitest-environment node
/**
 * O link "BLOQUEAR CONTATO" da mensagem. O que a rota promete:
 *   - navegador de verdade: chama o banco, confirma na hora — nunca redireciona pra lugar nenhum;
 *   - pré-visualização do WhatsApp e robô: NUNCA bloqueiam ninguém, nem chamam o banco;
 *   - token desconhecido: 404, nunca finge que bloqueou;
 *   - HEAD nunca bloqueia;
 *   - erro do banco: 404, fail-closed (nunca afirma "bloqueado" sem ter certeza).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));

import { GET, HEAD } from "@/app/bloquear/[token]/route";

const TOKEN = "9f3a1c0b7d2e4a5b6c7d";
const NAVEGADOR = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const req = (ua: string | null, metodo = "GET") =>
  new NextRequest(`http://localhost/bloquear/${TOKEN}`, { method: metodo, headers: ua ? { "user-agent": ua } : {} });
const params = (token = TOKEN) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.rpc.mockResolvedValue({ data: "ok", error: null });
});

describe("GET /bloquear/<token>", () => {
  it("navegador de verdade: chama o banco na hora, confirma, sem cache nem referrer, nunca redireciona", async () => {
    const res = await GET(req(NAVEGADOR), params());
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(h.rpc).toHaveBeenCalledWith("fn_campaign_block_contact", { p_token: TOKEN });
  });

  it("'already' (segundo clique) responde igual a 'ok' — quem clicou não percebe diferença", async () => {
    h.rpc.mockResolvedValue({ data: "already", error: null });
    const res = await GET(req(NAVEGADOR), params());
    expect(res.status).toBe(200);
  });

  it("token desconhecido: 404, e o texto não afirma que bloqueou", async () => {
    h.rpc.mockResolvedValue({ data: "unknown", error: null });
    const res = await GET(req(NAVEGADOR), params());
    expect(res.status).toBe(404);
    const corpo = await res.text();
    expect(corpo).not.toMatch(/vai mais receber/);
  });

  it("erro do banco: 404, nunca afirma bloqueado sem ter certeza", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "banco fora" } });
    const res = await GET(req(NAVEGADOR), params());
    expect(res.status).toBe(404);
  });

  it("pré-visualização do WhatsApp e robô: NUNCA bloqueiam, nem chamam o banco", async () => {
    for (const ua of ["WhatsApp/2.24.10.85 A", "curl/8.4.0", null]) {
      const res = await GET(req(ua), params());
      expect(res.status, String(ua)).toBe(200);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("HEAD /bloquear/<token>", () => {
  it("nunca bloqueia", async () => {
    const res = await HEAD(req(NAVEGADOR, "HEAD"), params());
    expect(res.status).toBe(200);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
