/**
 * GET /api/v1/campaigns/[id]/contacts — a aba Fila.
 *
 * Paginada por cursor (o `seq` da última linha) e com filtros no servidor: status, número,
 * grupo, versão da mensagem, quem clicou/respondeu, data da última atividade e busca por
 * nome ou telefone. NUNCA devolve a campanha inteira: com 45 mil contatos a tela recebe
 * 50 por vez.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { listarFila } from "@/lib/campaigns/leituras";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";
import { filaQuerySchema } from "@/lib/campaigns/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const query = filaQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) {
      return fail("validation_failed", c.t("Parâmetros inválidos."), 422, {
        requestId: c.requestId,
        details: query.error.flatten().fieldErrors as Record<string, unknown>,
      });
    }
    const { linhas, proximo } = await listarFila(c.db, c.org.orgId, id, query.data);
    return ok(linhas, { requestId: c.requestId, meta: { cursor: proximo === null ? null : String(proximo), has_more: proximo !== null } });
  });
}
