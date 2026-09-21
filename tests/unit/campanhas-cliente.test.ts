import { afterEach, describe, expect, it, vi } from "vitest";

import { chamar, ErroDaCentral, queryDaFila } from "@/hooks/campaigns/api";

afterEach(() => vi.unstubAllGlobals());

const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

describe("cliente da Central de Disparos", () => {
  it("devolve o envelope { data, meta } e manda JSON quando há corpo", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ data: { id: "c1" }, meta: { cursor: "9", has_more: true } }));
    vi.stubGlobal("fetch", f);
    const r = await chamar<{ id: string }>("", { method: "POST", json: { name: "Black" } });
    expect(r.data.id).toBe("c1");
    expect(r.meta?.cursor).toBe("9");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/v1/campaigns");
    expect(init.body).toBe(JSON.stringify({ name: "Black" }));
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("upload não força Content-Type (o navegador põe o boundary do multipart)", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ data: {} }));
    vi.stubGlobal("fetch", f);
    await chamar("/x/imports", { method: "POST", body: new FormData() });
    expect(f.mock.calls[0]![1].headers["Content-Type"]).toBeUndefined();
  });

  it("erro do servidor vira ErroDaCentral com a mensagem, o código e os detalhes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta({ error: { code: "version_conflict", message: "A mensagem foi alterada por outra pessoa.", details: { current_version_no: 3 } } }, 409)));
    const e = await chamar("/x/versions", { method: "POST", json: {} }).catch((x) => x);
    expect(e).toBeInstanceOf(ErroDaCentral);
    expect(e.code).toBe("version_conflict");
    expect(e.status).toBe(409);
    expect(e.details).toEqual({ current_version_no: 3 });
    expect(e.message).toContain("outra pessoa");
  });

  it("resposta que não é JSON ou rede caída viram mensagem humana, nunca um SyntaxError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })));
    const a = await chamar("/x").catch((x) => x);
    expect(a).toBeInstanceOf(ErroDaCentral);
    expect(a.message).toMatch(/Tente de novo/);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const b = await chamar("/x").catch((x) => x);
    expect(b.code).toBe("network");
    expect(b.message).toMatch(/internet/);
  });
});

describe("query da Fila", () => {
  it("só entra o que tem valor, em ordem estável", () => {
    expect(queryDaFila({})).toBe("");
    expect(queryDaFila({ status: ["pending", "queued"], clicked: true, q: "  ana ", after: 0, limit: 50 })).toBe("status=pending%2Cqueued&clicked=true&q=ana&limit=50");
    expect(queryDaFila({ replied: false, clicked: false, q: "   " })).toBe("");
    // A mesma seleção gera a mesma chave de cache, seja qual for a ordem em que foi montada.
    expect(queryDaFila({ q: "a", status: ["failed"] })).toBe(queryDaFila({ status: ["failed"], q: "a" }));
  });
});
