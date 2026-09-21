/**
 * GET    /api/v1/campaigns/[id]/imports/[importId] — onde a importação está.
 * DELETE /api/v1/campaigns/[id]/imports/[importId] — desiste: apaga o que ainda é dado cru.
 *
 * O estado mora no banco, então o GET responde igual depois de refresh, logout ou
 * reinício do servidor — a tela retoma do passo em que o operador parou.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { cancelarImportacao, resumoDaImportacao } from "@/lib/campaigns/importacao-service";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; importId: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const { id, importId } = await params;
    const invalido = idInvalido(c, id, importId);
    if (invalido) return invalido;
    const resumo = await resumoDaImportacao(c.db, c.org.orgId, importId);
    // A importação tem de ser DESTA campanha: o id da URL não é confiado.
    if (resumo.campaign_id !== id) return fail("not_found", c.t("Não encontrado."), 404, { requestId: c.requestId });
    return ok(resumo, { requestId: c.requestId });
  });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "importar", apoio: await requireSupportWrite() }, async (c) => {
    const { id, importId } = await params;
    const invalido = idInvalido(c, id, importId);
    if (invalido) return invalido;
    const resumo = await resumoDaImportacao(c.db, c.org.orgId, importId);
    if (resumo.campaign_id !== id) return fail("not_found", c.t("Não encontrado."), 404, { requestId: c.requestId });
    return ok(await cancelarImportacao(c.db, c.org.orgId, importId), { requestId: c.requestId });
  });
}
