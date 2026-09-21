// @vitest-environment node
/**
 * Rotas da importação de CSV — o contrato nas bordas.
 *
 * O banco (lotes, duplicados, retomada) é provado em
 * `tests/invariants/central-de-disparos-importacao.test.ts`, e a regra de telefone em
 * `tests/unit/campanhas-importacao.test.ts`. Aqui: o que é da ROTA — quem pode, o que
 * é recusado antes de tocar em qualquer coisa, a importação ser DESTA campanha, a
 * auditoria uma vez só, e o CSV que o operador baixa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";

const h = vi.hoisted(() => ({
  role: "manager" as "viewer" | "manager" | "admin",
  guard: vi.fn(),
  apoio: vi.fn(),
  audit: vi.fn(),
  criarImportacao: vi.fn(),
  validarImportacao: vi.fn(),
  importarEmLotes: vi.fn(),
  resumoDaImportacao: vi.fn(),
  cancelarImportacao: vi.fn(),
  rejeitadosDaImportacao: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.apoio }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/campaigns/service", async (original) => ({
  ...(await original<typeof import("@/lib/campaigns/service")>()),
  dbDeCampanhas: () => ({}) as never,
}));
vi.mock("@/lib/campaigns/importacao-service", () => ({
  criarImportacao: h.criarImportacao,
  validarImportacao: h.validarImportacao,
  importarEmLotes: h.importarEmLotes,
  resumoDaImportacao: h.resumoDaImportacao,
  cancelarImportacao: h.cancelarImportacao,
  rejeitadosDaImportacao: h.rejeitadosDaImportacao,
}));

import { POST as subir } from "@/app/api/v1/campaigns/[id]/imports/route";
import { DELETE as desistir, GET as resumo } from "@/app/api/v1/campaigns/[id]/imports/[importId]/route";
import { POST as validar } from "@/app/api/v1/campaigns/[id]/imports/[importId]/validate/route";
import { POST as importar } from "@/app/api/v1/campaigns/[id]/imports/[importId]/commit/route";
import { GET as rejeitados } from "@/app/api/v1/campaigns/[id]/imports/[importId]/rejects/route";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const USER = "b7c30000-0000-4000-8000-000000000002";
const CAMP = "b7c30000-0000-4000-8000-000000000003";
const OUTRA = "b7c30000-0000-4000-8000-0000000000aa";
const IMP = "b7c30000-0000-4000-8000-000000000005";
const RANK = { viewer: 1, manager: 4, admin: 5 } as const;
const p = { params: Promise.resolve({ id: CAMP }) };
const pi = { params: Promise.resolve({ id: CAMP, importId: IMP }) };

function upload(conteudo: string | Uint8Array, nome = "lista.csv", tipo = "text/csv"): NextRequest {
  const form = new FormData();
  form.set("file", new File([conteudo as BlobPart], nome, { type: tipo }));
  return new NextRequest("http://localhost/api/v1/campaigns/x/imports", { method: "POST", body: form });
}
const json = (corpo: unknown, method = "POST") =>
  new NextRequest("http://localhost/x", { method, body: JSON.stringify(corpo) });
const get = (qs = "") => new NextRequest(`http://localhost/x${qs}`);

const RESUMO = { import_id: IMP, campaign_id: CAMP, status: "validated", filename: "lista.csv", headers: ["Nome", "Telefone"], found: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "manager";
  h.apoio.mockResolvedValue(null);
  h.guard.mockImplementation(async (min: keyof typeof RANK) =>
    RANK[h.role] < RANK[min]
      ? { ok: false, response: fail("forbidden_role", "Papel insuficiente.", 403) }
      : { ok: true, user: { id: USER, idioma: "pt-BR" }, org: { orgId: ORG, name: "Org", role: h.role } },
  );
  h.resumoDaImportacao.mockResolvedValue(RESUMO);
});

describe("POST /imports — enviar o CSV", () => {
  it("lê o arquivo, grava a staging e devolve cabeçalho, amostra e mapeamento sugerido", async () => {
    h.criarImportacao.mockResolvedValue(IMP);
    const csv = "Nome;Celular;E-mail;Produto\nMaria;11999998888;m@x.com;Tênis\nJoão;11988887777;;Bota\n\n";
    const res = await subir(upload(csv), p);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ import_id: IMP, filename: "lista.csv", total_rows: 2, headers: ["Nome", "Celular", "E-mail", "Produto"] });
    expect(data.suggested_mapping).toMatchObject({ phone: 1, name: 0, email: 2 });
    expect(data.sample).toHaveLength(2);
    // A organização é a do papel resolvido, e a linha em branco do rodapé não conta.
    expect(h.criarImportacao).toHaveBeenCalledWith(
      expect.anything(), ORG, CAMP, USER,
      expect.objectContaining({ filename: "lista.csv", rows: [["Maria", "11999998888", "m@x.com", "Tênis"], ["João", "11988887777", "", "Bota"]] }),
    );
  });

  it("recusa o que não é CSV, arquivo vazio, sem linhas de dados e binário", async () => {
    expect((await subir(upload("a,b\n1,2", "planilha.xlsx", "application/octet-stream"), p)).status).toBe(422);
    expect((await subir(upload("Nome,Telefone\n"), p)).status).toBe(422);
    expect((await subir(upload(""), p)).status).toBe(422);
    expect((await subir(upload(new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 9, 0, 0, 0])), p)).status).toBe(422);
    expect(h.criarImportacao).not.toHaveBeenCalled();
  });

  it("recusa arquivo acima do teto antes de ler", async () => {
    const res = await subir(upload(new Uint8Array(16 * 1024 * 1024).fill(97)), p);
    expect(res.status).toBe(413);
    expect(h.criarImportacao).not.toHaveBeenCalled();
  });

  it("sem o campo `file` responde 422", async () => {
    const form = new FormData();
    form.set("outro", "x");
    const res = await subir(new NextRequest("http://localhost/x", { method: "POST", body: form }), p);
    expect(res.status).toBe(422);
  });

  it("viewer não envia arquivo e o modo suporte somente-leitura barra", async () => {
    h.role = "viewer";
    expect((await subir(upload("Nome,Telefone\nA,1"), p)).status).toBe(403);
    h.role = "manager";
    h.apoio.mockResolvedValue(fail("forbidden", "Somente leitura.", 403));
    expect((await subir(upload("Nome,Telefone\nA,1"), p)).status).toBe(403);
    expect(h.criarImportacao).not.toHaveBeenCalled();
  });
});

describe("importação é DESTA campanha", () => {
  it("resumo, validação, importação, rejeitados e cancelamento respondem 404 para importação de outra campanha", async () => {
    h.resumoDaImportacao.mockResolvedValue({ ...RESUMO, campaign_id: OUTRA });
    expect((await resumo(get(), pi)).status).toBe(404);
    expect((await validar(json({ phone: 0 }), pi)).status).toBe(404);
    expect((await importar(json({}), pi)).status).toBe(404);
    expect((await rejeitados(get(), pi)).status).toBe(404);
    expect((await desistir(json({}, "DELETE"), pi)).status).toBe(404);
    expect(h.validarImportacao).not.toHaveBeenCalled();
    expect(h.importarEmLotes).not.toHaveBeenCalled();
    expect(h.cancelarImportacao).not.toHaveBeenCalled();
  });

  it("id que não é UUID nem chega ao banco", async () => {
    const ruim = { params: Promise.resolve({ id: CAMP, importId: "1; drop table x" }) };
    expect((await resumo(get(), ruim)).status).toBe(404);
    expect(h.resumoDaImportacao).not.toHaveBeenCalled();
  });
});

describe("validar e importar", () => {
  it("validar aplica o mapeamento estrito e devolve o resumo da prévia", async () => {
    h.validarImportacao.mockResolvedValue({ ...RESUMO, valid: 44732, rejected: 268 });
    const res = await validar(json({ phone: 1, name: 0, extras: [{ key: "produto", index: 3 }] }), pi);
    expect(res.status).toBe(200);
    expect(h.validarImportacao).toHaveBeenCalledWith(expect.anything(), ORG, IMP, expect.objectContaining({ phone: 1, name: 0 }));
    expect((await validar(json({ phone: 1, organization_id: ORG }), pi)).status).toBe(422);
  });

  it("importar audita UMA vez, só na chamada que terminou o trabalho", async () => {
    h.importarEmLotes.mockResolvedValueOnce({ processed: 1500, remaining: 700, status: "importing" });
    expect((await importar(json({}), pi)).status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();

    h.importarEmLotes.mockResolvedValueOnce({ processed: 700, remaining: 0, status: "done" });
    h.resumoDaImportacao.mockResolvedValue({ ...RESUMO, status: "done", imported: 2200, rejected: 30, by_reason: { invalid_phone: 30 } });
    expect((await importar(json({}), pi)).status).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "campaign.imported", resourceId: CAMP, metadata: expect.objectContaining({ imported: 2200 }) }));

    h.audit.mockClear();
    h.importarEmLotes.mockResolvedValueOnce({ processed: 0, remaining: 0, status: "done" });
    await importar(json({}), pi);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("desistir passa pelo guard de escrita", async () => {
    h.cancelarImportacao.mockResolvedValue({ changed: true, status: "cancelled" });
    expect((await desistir(json({}, "DELETE"), pi)).status).toBe(200);
    h.apoio.mockResolvedValue(fail("forbidden", "Somente leitura.", 403));
    expect((await desistir(json({}, "DELETE"), pi)).status).toBe(403);
  });
});

describe("rejeitados", () => {
  it("json em páginas e csv para baixar, com fórmula neutralizada", async () => {
    h.rejeitadosDaImportacao.mockResolvedValue({ linhas: [{ line_no: 2, reason: "invalid_phone", cells: ["=evil", "123"] }], proximo: null });
    const j = await rejeitados(get("?limit=50"), pi);
    expect(j.status).toBe(200);
    expect((await j.json()).meta).toMatchObject({ has_more: false });

    const csv = await rejeitados(get("?format=csv"), pi);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    expect(csv.headers.get("cache-control")).toBe("no-store");
    const texto = await csv.text();
    expect(texto).toContain(`"'=evil"`);
    expect(texto).toContain("Telefone inválido");
  });

  it("viewer não vê as linhas cruas (dado pessoal)", async () => {
    h.role = "viewer";
    expect((await rejeitados(get(), pi)).status).toBe(403);
    expect(h.rejeitadosDaImportacao).not.toHaveBeenCalled();
    expect((await rejeitados(get("?limit=9999"), pi)).status).toBe(403);
  });

  it("parâmetro fora do limite é recusado", async () => {
    expect((await rejeitados(get("?limit=9999"), pi)).status).toBe(422);
    expect((await rejeitados(get("?format=xml"), pi)).status).toBe(422);
  });
});
