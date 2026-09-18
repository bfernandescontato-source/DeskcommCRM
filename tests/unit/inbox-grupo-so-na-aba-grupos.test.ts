import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

/**
 * GRUPO DO WHATSAPP SÓ APARECE NA ABA GRUPOS.
 *
 * Depois que o grupo virou conversa (migration 0276) ele passou a aparecer em
 * Fila, Todas e nas contagens, misturado às conversas com pessoas. O padrão certo
 * é o de antes de a 0276: lista e badge excluem grupo, e só o pedido explícito
 * (`is_group=true`, a aba Grupos) o inclui.
 *
 * A lista e a contagem são duas consultas escritas separadamente — e a regra
 * deste produto (ver o cabeçalho de `counts/route.ts`) é que o badge conta
 * EXATAMENTE o que a aba lista. Por isso os dois lados são vigiados aqui.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "manager" }),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/ai/agents/org-tem-automatico", () => ({ orgTemAutomatico: async () => true }));

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA (mesmo padrão de `nao-lidos-filtra-no-banco`). */
function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: [], error: null, count: 0 });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

const filtrosDeGrupo = (c: Chamada[]) =>
  c
    .filter((x) => x.tabela === "conversations" && x.metodo === "eq" && x.args[0] === "is_group")
    .map((x) => x.args[1]);

describe("a LISTA exclui grupo, salvo quando pedido", () => {
  async function listar(query: Record<string, unknown>) {
    const { client, chamadas } = fakeSupabase();
    await listConversationsHandler(client as never, ctx, { limit: 50, ...query } as never);
    return chamadas;
  }

  it("⭐ sem `is_group` (Fila, Minhas, Todas, Fechadas, MCP), a consulta pede is_group=false", async () => {
    expect(filtrosDeGrupo(await listar({}))).toEqual([false]);
  });

  it("a aba Grupos (`is_group: true`) pede is_group=true — e SÓ isso", async () => {
    expect(filtrosDeGrupo(await listar({ is_group: true }))).toEqual([true]);
  });

  it("o padrão convive com os demais filtros da aba", async () => {
    const c = await listar({ exclude_finished: true, unread: true });
    expect(filtrosDeGrupo(c)).toEqual([false]);
    expect(c.filter((x) => x.metodo === "gt").length).toBeGreaterThan(0);
  });
});

describe("a CONTAGEM espelha a lista", () => {
  async function contar() {
    const { client, chamadas } = fakeSupabase();
    const { createClient } = await import("@/lib/supabase/server");
    vi.mocked(createClient).mockResolvedValue(client as never);
    const { GET } = await import("@/app/api/v1/conversations/counts/route");
    const res = await GET(new NextRequest("http://x/api/v1/conversations/counts"));
    expect(res.status).toBe(200);
    return chamadas.filter((x) => x.tabela === "conversations");
  }

  it("⭐ só UMA contagem (a da aba Grupos) pede is_group=true; todas as outras pedem false", async () => {
    const c = await contar();
    const porConsulta = c.filter((x) => x.metodo === "eq" && x.args[0] === "is_group").map((x) => x.args[1]);
    // fila, automático, minhas, todas, grupos, fechadas, arquivadas
    expect(porConsulta).toHaveLength(7);
    expect(porConsulta.filter((v) => v === true)).toHaveLength(1);
    expect(porConsulta.filter((v) => v === false)).toHaveLength(6);
  });
});
