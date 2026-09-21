/**
 * GET /campaigns/[id]/events — a aba Atividade pede só o que aconteceu com a CAMPANHA
 * (`scope=campaign`): 45 mil envios individuais afogariam as dez decisões que importam.
 * Cada evento sai com o nome de quem agiu, e o cursor é o do último item.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";

const h = vi.hoisted(() => ({
  role: "manager" as "viewer" | "manager",
  guard: vi.fn(),
  listarEventos: vi.fn(),
  nomes: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/campaigns/service", async (original) => ({
  ...(await original<typeof import("@/lib/campaigns/service")>()),
  dbDeCampanhas: () => ({}) as never,
  listarEventos: h.listarEventos,
}));
vi.mock("@/lib/campaigns/leituras", async (original) => ({
  ...(await original<typeof import("@/lib/campaigns/leituras")>()),
  nomesDeQuemAgiu: h.nomes,
}));

import { GET } from "@/app/api/v1/campaigns/[id]/events/route";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const USER = "b7c30000-0000-4000-8000-000000000002";
const CAMP = "b7c30000-0000-4000-8000-000000000003";
const RANK = { viewer: 1, manager: 4 } as const;
const chamar = (qs = "") => GET(new NextRequest(`http://localhost/x${qs}`), { params: Promise.resolve({ id: CAMP }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "manager";
  h.guard.mockImplementation(async (min: keyof typeof RANK) =>
    RANK[h.role] < RANK[min]
      ? { ok: false, response: fail("forbidden_role", "Papel insuficiente.", 403) }
      : { ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, name: "Org", role: h.role } },
  );
  h.nomes.mockResolvedValue(new Map([[USER, "Bruno"]]));
});

describe("eventos da campanha", () => {
  it("scope=campaign vira 'só da campanha' no serviço; sem ele, tudo (perfil do contato usa ?contact)", async () => {
    h.listarEventos.mockResolvedValue({ eventos: [], nextCursor: null });
    await chamar("?scope=campaign&limit=20");
    expect(h.listarEventos).toHaveBeenLastCalledWith(expect.anything(), ORG, CAMP, expect.objectContaining({ limit: 20, somenteDaCampanha: true }));
    await chamar();
    expect(h.listarEventos).toHaveBeenLastCalledWith(expect.anything(), ORG, CAMP, expect.objectContaining({ somenteDaCampanha: false }));
  });

  it("devolve o nome de quem agiu e o cursor da próxima página", async () => {
    h.listarEventos.mockResolvedValue({
      eventos: [
        { id: "e1", kind: "paused", actor_user_id: USER, occurred_at: "2026-09-21T15:00:00Z", payload: {} },
        { id: "e2", kind: "completed", actor_user_id: null, occurred_at: "2026-09-21T14:00:00Z", payload: {} },
      ],
      nextCursor: "abc",
    });
    const j = await (await chamar("?scope=campaign")).json();
    expect(j.data.map((e: { actor_name: string | null }) => e.actor_name)).toEqual(["Bruno", null]);
    expect(j.meta).toEqual({ cursor: "abc", has_more: true });
    expect(h.nomes).toHaveBeenCalledWith(expect.anything(), ORG, [USER, null]);
  });

  it("scope inventado é recusado; viewer não lê", async () => {
    expect((await chamar("?scope=tudo")).status).toBe(422);
    h.role = "viewer";
    expect((await chamar("?scope=campaign")).status).toBe(403);
  });
});
