/**
 * GET /api/v1/campaigns/[id]/imports/[importId]/rejects — as linhas que não entraram.
 *
 * `?format=json` (padrão): páginas por número de linha, para a tela "ver os inválidos".
 * `?format=csv`: o arquivo inteiro para o operador baixar, corrigir e reenviar. Toda
 * célula sai com fórmula neutralizada (o conteúdo veio de fora e vai abrir numa planilha).
 *
 * Contém dado pessoal cru da planilha: exige o mesmo papel de quem importa.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { rejeitadosParaCsv } from "@/lib/campaigns/importacao";
import { rejeitadosDaImportacao, resumoDaImportacao, type LinhaRejeitada } from "@/lib/campaigns/importacao-service";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";
import { rejeitadosQuerySchema } from "@/lib/campaigns/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; importId: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "importar" }, async (c) => {
    const { id, importId } = await params;
    const invalido = idInvalido(c, id, importId);
    if (invalido) return invalido;
    const query = rejeitadosQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) {
      return fail("validation_failed", c.t("Parâmetros inválidos."), 422, {
        requestId: c.requestId,
        details: query.error.flatten().fieldErrors as Record<string, unknown>,
      });
    }
    const resumo = await resumoDaImportacao(c.db, c.org.orgId, importId);
    if (resumo.campaign_id !== id) return fail("not_found", c.t("Não encontrado."), 404, { requestId: c.requestId });

    if (query.data.format === "json") {
      const { linhas, proximo } = await rejeitadosDaImportacao(c.db, c.org.orgId, importId, {
        depoisDe: query.data.after,
        limite: query.data.limit,
      });
      return ok(linhas, { requestId: c.requestId, meta: { cursor: proximo === null ? null : String(proximo), has_more: proximo !== null } });
    }

    const todas: LinhaRejeitada[] = [];
    let depoisDe = 0;
    for (;;) {
      const { linhas, proximo } = await rejeitadosDaImportacao(c.db, c.org.orgId, importId, { depoisDe, limite: 500 });
      todas.push(...linhas);
      if (proximo === null) break;
      depoisDe = proximo;
    }
    return new Response(rejeitadosParaCsv(resumo.headers, todas), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="rejeitados-${importId.slice(0, 8)}.csv"`,
        "Cache-Control": "no-store",
        "X-Request-Id": c.requestId,
      },
    });
  });
}
