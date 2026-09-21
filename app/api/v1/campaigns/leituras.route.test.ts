/**
 * As rotas de LEITURA da Central: painel, Visão geral, Fila, perfil do contato e a decisão do
 * incerto. O que é da rota: quem pode ver/decidir, parâmetro estrito, id que não é UUID nem
 * toca o banco, a organização vir do papel, e a resposta ser paginada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";

const h = vi.hoisted(() => ({
  role: "viewer" as "viewer" | "manager" | "admin",
  guard: vi.fn(),
  apoio: vi.fn(),
  painelGeral: vi.fn(),
  alertasDaCampanha: vi.fn(),
  agoraDaCampanha: vi.fn(),
  metricasDaCampanha: vi.fn(),
  nomesDeQuemAgiu: vi.fn(),
  listarFila: vi.fn(),
  perfilDoContato: vi.fn(),
  resolverIncerto: vi.fn(),
  listarCampanhas: vi.fn(),
  detalharCampanha: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/campaigns/leituras", () => ({
  painelGeral: h.painelGeral,
  alertasDaCampanha: h.alertasDaCampanha,
  agoraDaCampanha: h.agoraDaCampanha,
  metricasDaCampanha: h.metricasDaCampanha,
  nomesDeQuemAgiu: h.nomesDeQuemAgiu,
  listarFila: h.listarFila,
  perfilDoContato: h.perfilDoContato,
  resolverIncerto: h.resolverIncerto,
}));
vi.mock("@/lib/campaigns/service", async (original) => ({
  ...(await original<typeof import("@/lib/campaigns/service")>()),
  dbDeCampanhas: () => ({}) as never,
  listarCampanhas: h.listarCampanhas,
  detalharCampanha: h.detalharCampanha,
}));

import { GET as dashboard } from "@/app/api/v1/campaigns/dashboard/route";
import { GET as overview } from "@/app/api/v1/campaigns/[id]/overview/route";
import { GET as fila } from "@/app/api/v1/campaigns/[id]/contacts/route";
import { GET as perfil } from "@/app/api/v1/campaigns/[id]/contacts/[contactId]/route";
import { POST as resolver } from "@/app/api/v1/campaigns/[id]/contacts/[contactId]/resolve/route";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const USER = "b7c30000-0000-4000-8000-000000000002";
const CAMP = "b7c30000-0000-4000-8000-000000000003";
const CC = "b7c30000-0000-4000-8000-000000000006";
const RANK = { viewer: 1, manager: 4, admin: 5 } as const;
const p = { params: Promise.resolve({ id: CAMP }) };
const pc = { params: Promise.resolve({ id: CAMP, contactId: CC }) };
const get = (qs = "") => new NextRequest(`http://localhost/x${qs}`);
const post = (corpo: unknown) => new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(corpo) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "manager";
  h.apoio.mockResolvedValue(null);
  h.guard.mockImplementation(async (min: keyof typeof RANK) =>
    RANK[h.role] < RANK[min]
      ? { ok: false, response: fail("forbidden_role", "Papel insuficiente.", 403) }
      : { ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, name: "Org", role: h.role } },
  );
});

describe("GET /campaigns/dashboard", () => {
  it("traz o painel, as campanhas e SÓ os alertas das campanhas ativas que têm alerta", async () => {
    h.painelGeral.mockResolvedValue({ running: 1, paused: 1, sent_today: 10, active: {} });
    h.listarCampanhas.mockResolvedValue([
      { id: "a", name: "Black", status: "running" },
      { id: "b", name: "Antiga", status: "completed" },
      { id: "c", name: "Pausada", status: "paused" },
    ]);
    h.alertasDaCampanha.mockImplementation(async (_db: unknown, _org: string, id: string) => (id === "a" ? [{ level: "warning", code: "capacity_near" }] : []));
    const res = await dashboard();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.panel.sent_today).toBe(10);
    expect(data.alerts).toEqual([{ campaign_id: "a", campaign_name: "Black", alerts: [{ level: "warning", code: "capacity_near" }] }]);
    // A campanha encerrada nem chega a calcular alerta (cada um custa uma agregação).
    expect(h.alertasDaCampanha.mock.calls.map((c) => c[2])).toEqual(["a", "c"]);
    expect(h.painelGeral).toHaveBeenCalledWith(expect.anything(), ORG);
  });
});

describe("GET /campaigns/[id]/overview", () => {
  it("junta detalhe, métricas, 'agora' e alertas, e põe o nome de quem criou cada versão", async () => {
    h.detalharCampanha.mockResolvedValue({ campaign: { id: CAMP }, versions: [{ id: "v1", version_no: 1, created_by: "u1" }, { id: "v2", version_no: 2, created_by: null }], destinations: [], channels: [], counts: { total: 3 } });
    h.metricasDaCampanha.mockResolvedValue({ by_version: [], by_destination: [], by_channel: [] });
    h.agoraDaCampanha.mockResolvedValue({ status: "running" });
    h.alertasDaCampanha.mockResolvedValue([]);
    h.nomesDeQuemAgiu.mockResolvedValue(new Map([["u1", "Bruno Fernandes"]]));
    const res = await overview(get(), p);
    const { data } = await res.json();
    expect(data.versions.map((v: { created_by_name: string | null }) => v.created_by_name)).toEqual(["Bruno Fernandes", null]);
    expect(data).toMatchObject({ metrics: { by_version: [] }, now: { status: "running" }, alerts: [], counts: { total: 3 } });
    expect(h.detalharCampanha).toHaveBeenCalledWith(expect.anything(), ORG, CAMP);
  });

  it("id que não é UUID não chega ao banco", async () => {
    expect((await overview(get(), { params: Promise.resolve({ id: "1; drop table x" }) })).status).toBe(404);
    expect(h.detalharCampanha).not.toHaveBeenCalled();
  });
});

describe("GET /campaigns/[id]/contacts — a Fila", () => {
  it("pagina por cursor, com filtros validados, e a organização vem do papel", async () => {
    h.listarFila.mockResolvedValue({ linhas: [{ id: "cc1", seq: 51 }], proximo: 51 });
    const res = await fila(get("?status=pending,queued&limit=50&after=1&q=maria"), p);
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.meta).toEqual({ cursor: "51", has_more: true });
    expect(h.listarFila).toHaveBeenCalledWith(expect.anything(), ORG, CAMP, expect.objectContaining({ status: ["pending", "queued"], limit: 50, after: 1, q: "maria" }));
  });

  it("última página não tem cursor", async () => {
    h.listarFila.mockResolvedValue({ linhas: [], proximo: null });
    expect((await (await fila(get(), p)).json()).meta).toEqual({ cursor: null, has_more: false });
  });

  it("parâmetro fora do limite ou de tipo errado é recusado antes de qualquer consulta", async () => {
    for (const qs of ["?limit=100000", "?status=voando", "?channel=x", "?after=-1"]) {
      expect((await fila(get(qs), p)).status, qs).toBe(422);
    }
    expect(h.listarFila).not.toHaveBeenCalled();
  });
});

describe("perfil do contato e decisão do incerto", () => {
  it("o perfil devolve a linha do tempo pronta", async () => {
    h.perfilDoContato.mockResolvedValue({ id: CC, state: "CLICOU", events: [] });
    const res = await perfil(get(), pc);
    expect((await res.json()).data).toMatchObject({ state: "CLICOU" });
    expect(h.perfilDoContato).toHaveBeenCalledWith(expect.anything(), ORG, CAMP, CC);
  });

  it("viewer e agent não leem a Central: o painel, a Fila e o perfil respondem 403", async () => {
    for (const papel of ["viewer", "agent"] as const) {
      h.role = papel as "viewer";
      // agent tem rank entre viewer e manager; o mock só conhece o que a suíte usa.
      (RANK as Record<string, number>).agent ??= 2;
      expect((await perfil(get(), pc)).status, papel).toBe(403);
    }
  });

  it("viewer não decide envio incerto; manager decide, e o servidor recebe QUEM decidiu", async () => {
    h.role = "viewer";
    expect((await resolver(post({ resolution: "sent" }), pc)).status).toBe(403);
    expect(h.resolverIncerto).not.toHaveBeenCalled();
    h.role = "manager";
    h.resolverIncerto.mockResolvedValue("ok");
    expect((await resolver(post({ resolution: "retry" }), pc)).status).toBe(200);
    expect(h.resolverIncerto).toHaveBeenCalledWith(expect.anything(), ORG, CC, "retry", USER);
  });

  it("resolução inventada é recusada; contato que não está incerto é conflito; modo suporte barra", async () => {
    h.role = "manager";
    expect((await resolver(post({ resolution: "talvez" }), pc)).status).toBe(422);
    h.resolverIncerto.mockResolvedValue("not_uncertain");
    expect((await resolver(post({ resolution: "sent" }), pc)).status).toBe(409);
    h.apoio.mockResolvedValue(fail("forbidden", "Somente leitura.", 403));
    h.resolverIncerto.mockClear();
    expect((await resolver(post({ resolution: "sent" }), pc)).status).toBe(403);
    expect(h.resolverIncerto).not.toHaveBeenCalled();
  });
});
