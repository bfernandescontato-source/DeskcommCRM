/**
 * Rotas da Central de Disparos — o contrato de segurança e de erro, nas bordas.
 *
 * A máquina de estados mora no banco e é provada em
 * `tests/invariants/central-de-disparos-nucleo.test.ts`. Aqui se prova o que é da
 * ROTA:
 *
 *  1. a organização vem do papel resolvido, nunca do corpo (corpo com
 *     `organization_id` é recusado, não ignorado);
 *  2. INICIAR / ENCERRAR / CANCELAR exigem admin; PAUSAR, manager — e quem não
 *     tem o papel nunca chega ao serviço;
 *  3. a auditoria só é gravada quando houve efeito (`changed`), não a cada clique;
 *  4. o modo suporte somente-leitura barra toda escrita;
 *  5. erro do banco vira código estável, e id que não é UUID nem toca o banco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";

const h = vi.hoisted(() => ({
  role: "manager" as "viewer" | "manager" | "admin",
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  criarCampanha: vi.fn(),
  listarCampanhas: vi.fn(),
  detalharCampanha: vi.fn(),
  atualizarConfiguracao: vi.fn(),
  transicionar: vi.fn(),
  definirCanais: vi.fn(),
  criarVersao: vi.fn(),
  cadastrarDestino: vi.fn(),
  trocarDestino: vi.fn(),
  listarEventos: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/campaigns/service", async (original) => {
  const real = await original<typeof import("@/lib/campaigns/service")>();
  return {
    ...real,
    dbDeCampanhas: () => ({}) as never,
    criarCampanha: h.criarCampanha,
    listarCampanhas: h.listarCampanhas,
    detalharCampanha: h.detalharCampanha,
    atualizarConfiguracao: h.atualizarConfiguracao,
    transicionar: h.transicionar,
    definirCanais: h.definirCanais,
    criarVersao: h.criarVersao,
    cadastrarDestino: h.cadastrarDestino,
    trocarDestino: h.trocarDestino,
    listarEventos: h.listarEventos,
  };
});

import { GET as listar, POST as criar } from "@/app/api/v1/campaigns/route";
import { GET as detalhar } from "@/app/api/v1/campaigns/[id]/route";
import { POST as transicao } from "@/app/api/v1/campaigns/[id]/transition/route";
import { POST as versoes } from "@/app/api/v1/campaigns/[id]/versions/route";
import { POST as destinos } from "@/app/api/v1/campaigns/[id]/destinations/route";
import { POST as ativarDestino } from "@/app/api/v1/campaigns/[id]/destinations/[destinationId]/activate/route";
import { CampanhaError } from "@/lib/campaigns/service";
import { erroDaCampanha } from "@/lib/campaigns/erros";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const USER = "b7c30000-0000-4000-8000-000000000002";
const CAMP = "b7c30000-0000-4000-8000-000000000003";
const DEST = "b7c30000-0000-4000-8000-000000000004";
const RANK = { viewer: 1, manager: 4, admin: 5 } as const;

const req = (corpo?: unknown, url = "http://localhost/api/v1/campaigns") =>
  new NextRequest(url, { method: corpo === undefined ? "GET" : "POST", body: corpo === undefined ? undefined : JSON.stringify(corpo) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "manager";
  h.apoio.mockResolvedValue(null);
  // Nega quando o papel real (h.role) é menor que o pedido.
  h.guard.mockImplementation(async (min: keyof typeof RANK) => {
    if (RANK[h.role] < RANK[min]) {
      return { ok: false, response: fail("forbidden_role", "Papel insuficiente.", 403) };
    }
    return { ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, name: "Org", role: h.role } };
  });
});

describe("POST /campaigns", () => {
  it("cria com a organização do papel resolvido e audita", async () => {
    h.criarCampanha.mockResolvedValue(CAMP);
    const res = await criar(req({ name: "Black Friday 2026" }));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ id: CAMP });
    expect(h.criarCampanha).toHaveBeenCalledWith(expect.anything(), ORG, USER, expect.objectContaining({ name: "Black Friday 2026" }));
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "campaign.created", organizationId: ORG, actorUserId: USER, resourceId: CAMP }),
    );
  });

  it("corpo com organization_id é RECUSADO, não ignorado", async () => {
    const res = await criar(req({ name: "X", organization_id: "b7c30000-0000-4000-8000-0000000000ff" }));
    expect(res.status).toBe(422);
    expect(h.criarCampanha).not.toHaveBeenCalled();
  });

  it("agent/viewer não criam; o serviço nem é chamado", async () => {
    h.role = "viewer";
    const res = await criar(req({ name: "X" }));
    expect(res.status).toBe(403);
    expect(h.criarCampanha).not.toHaveBeenCalled();
  });

  it("no modo suporte somente-leitura nada é escrito", async () => {
    h.apoio.mockResolvedValue(fail("forbidden", "O acompanhamento é somente leitura.", 403));
    const res = await criar(req({ name: "X" }));
    expect(res.status).toBe(403);
    expect(h.criarCampanha).not.toHaveBeenCalled();
  });

  it("GET lista para quem só lê", async () => {
    h.role = "viewer";
    h.listarCampanhas.mockResolvedValue([]);
    const res = await listar();
    expect(res.status).toBe(200);
    expect(h.listarCampanhas).toHaveBeenCalledWith(expect.anything(), ORG);
  });
});

describe("GET /campaigns/[id]", () => {
  it("id que não é UUID responde 404 sem tocar o banco", async () => {
    const res = await detalhar(req(), params({ id: "1; drop table campaigns" }));
    expect(res.status).toBe(404);
    expect(h.detalharCampanha).not.toHaveBeenCalled();
  });

  it("campanha de outra organização não é encontrada (o serviço recebe a org do papel)", async () => {
    h.detalharCampanha.mockRejectedValue(new CampanhaError(erroDaCampanha({ message: "campaign_not_found" })));
    const res = await detalhar(req(), params({ id: CAMP }));
    expect(res.status).toBe(404);
    expect(h.detalharCampanha).toHaveBeenCalledWith(expect.anything(), ORG, CAMP);
  });
});

describe("POST /campaigns/[id]/transition", () => {
  const chama = (action: string) => transicao(req({ action }), params({ id: CAMP }));

  it("manager pausa; audita só quando houve efeito", async () => {
    h.transicionar.mockResolvedValue({ changed: true, from: "running", to: "paused" });
    expect((await chama("pause")).status).toBe(200);
    expect(h.transicionar).toHaveBeenCalledWith(expect.anything(), ORG, CAMP, USER, "pause", undefined);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "campaign.paused", resourceId: CAMP }));

    h.audit.mockClear();
    h.transicionar.mockResolvedValue({ changed: false, from: "paused", to: "paused" });
    expect((await chama("pause")).status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("manager NÃO inicia, encerra nem cancela — o serviço não é chamado", async () => {
    for (const acao of ["start", "complete", "cancel"]) {
      const res = await chama(acao);
      expect(res.status, acao).toBe(403);
    }
    expect(h.transicionar).not.toHaveBeenCalled();
  });

  it("admin inicia e a auditoria leva de/para", async () => {
    h.role = "admin";
    h.transicionar.mockResolvedValue({ changed: true, from: "ready", to: "running" });
    expect((await chama("start")).status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "campaign.started", metadata: expect.objectContaining({ from: "ready", to: "running" }) }),
    );
  });

  it("'fail' é do sistema: a API recusa", async () => {
    h.role = "admin";
    expect((await chama("fail")).status).toBe(422);
    expect(h.transicionar).not.toHaveBeenCalled();
  });

  it("transição inválida vira 409 com de/para; falta de requisito vira 422 com o passo a refazer", async () => {
    h.role = "admin";
    h.transicionar.mockRejectedValue(new CampanhaError(erroDaCampanha({ message: "campaign_invalid_transition", details: "cancelled -> running" })));
    const r1 = await chama("resume");
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toMatchObject({ code: "invalid_transition", details: { from: "cancelled", to: "running" } });

    h.transicionar.mockRejectedValue(new CampanhaError(erroDaCampanha({ message: "campaign_no_channel" })));
    const r2 = await chama("start");
    expect(r2.status).toBe(422);
    expect((await r2.json()).error.details).toEqual({ missing: "channel" });
  });

  it("erro inesperado vira 500 sem vazar a causa", async () => {
    h.transicionar.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const res = await chama("pause");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.5");
  });
});

describe("POST /campaigns/[id]/versions", () => {
  it("cria a versão e audita de/para", async () => {
    h.criarVersao.mockResolvedValue({ version_id: "v", version_no: 3, activated: true, previous_version_no: 2 });
    const res = await versoes(req({ body: "Oi {{nome}}, {{link_grupo}}", based_on_version_no: 2 }), params({ id: CAMP }));
    expect(res.status).toBe(201);
    expect(h.criarVersao).toHaveBeenCalledWith(expect.anything(), ORG, CAMP, USER, expect.objectContaining({ based_on_version_no: 2, activate: true }));
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "campaign.version_created",
        metadata: expect.objectContaining({ version_no: 3, previous_version_no: 2, variables: ["nome", "link_grupo"] }),
      }),
    );
  });

  it("variável mal formada não chega ao banco (iria literal para milhares de pessoas)", async () => {
    const res = await versoes(req({ body: "Oi {{nome}" }), params({ id: CAMP }));
    expect(res.status).toBe(422);
    expect(h.criarVersao).not.toHaveBeenCalled();
  });

  it("conflito de versão devolve 409 com a versão atual", async () => {
    h.criarVersao.mockRejectedValue(new CampanhaError(erroDaCampanha({ message: "campaign_version_conflict", details: "current=4" })));
    const res = await versoes(req({ body: "Nova", based_on_version_no: 2 }), params({ id: CAMP }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "version_conflict", details: { current_version_no: 4 } });
  });
});

describe("destinos", () => {
  it("cadastrar e trocar audita as duas decisões", async () => {
    h.cadastrarDestino.mockResolvedValue({
      destination_id: DEST,
      sequence_no: 2,
      activated: true,
      switch: { changed: true, previous_destination_id: "d1" },
    });
    const res = await destinos(
      req({ name: "BLACK #02", invite_url: "https://chat.whatsapp.com/AbCdEf123456", capacity: 950, activate: true, expected_current: "b7c30000-0000-4000-8000-0000000000d1" }),
      params({ id: CAMP }),
    );
    expect(res.status).toBe(201);
    const acoes = h.audit.mock.calls.map((c) => c[0].action);
    expect(acoes).toEqual(["campaign.destination_added", "campaign.destination_changed"]);
  });

  it("recusa link fora do WhatsApp ou sem https", async () => {
    for (const invite_url of ["http://chat.whatsapp.com/AbCdEf123456", "https://evil.example/AbCdEf123456", "javascript:alert(1)"]) {
      const res = await destinos(req({ name: "X", invite_url }), params({ id: CAMP }));
      expect(res.status, invite_url).toBe(422);
    }
    expect(h.cadastrarDestino).not.toHaveBeenCalled();
  });

  it("trocar para o destino que já é o ativo não gera auditoria", async () => {
    h.trocarDestino.mockResolvedValue({ changed: false, destination_id: DEST });
    const res = await ativarDestino(req({}), params({ id: CAMP, destinationId: DEST }));
    expect(res.status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("troca real audita e devolve conflito quando a tela estava desatualizada", async () => {
    h.trocarDestino.mockResolvedValueOnce({ changed: true, destination_id: DEST, previous_destination_id: "d1" });
    expect((await ativarDestino(req({}), params({ id: CAMP, destinationId: DEST }))).status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "campaign.destination_changed" }));

    h.trocarDestino.mockRejectedValueOnce(new CampanhaError(erroDaCampanha({ message: "campaign_destination_conflict" })));
    const res = await ativarDestino(req({ expected_current: "b7c30000-0000-4000-8000-0000000000d1" }), params({ id: CAMP, destinationId: DEST }));
    expect(res.status).toBe(409);
  });
});
