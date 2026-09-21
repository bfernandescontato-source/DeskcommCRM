/**
 * POST /api/v1/campaigns/[id]/imports/[importId]/commit — passo 3: importar.
 *
 * Promove as linhas válidas para contatos + fila da campanha, em lotes de uma
 * transação cada. Trabalha por até ~15s e devolve o que sobrou (`remaining`): a tela
 * chama de novo enquanto houver resto, e essa repetição é a barra de progresso.
 * Repetir a chamada é inofensivo — a linha importada sai da fila de importação.
 *
 * Contato que já existe é reaproveitado (nunca duplicado); o novo nasce sem disparar
 * automação, IA ou notificação — importar 45 mil pessoas não pode acordar nada disso.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { importarEmLotes, resumoDaImportacao } from "@/lib/campaigns/importacao-service";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; importId: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "importar", apoio: await requireSupportWrite() }, async (c) => {
    const { id, importId } = await params;
    const invalido = idInvalido(c, id, importId);
    if (invalido) return invalido;
    const antes = await resumoDaImportacao(c.db, c.org.orgId, importId);
    if (antes.campaign_id !== id) return fail("not_found", c.t("Não encontrado."), 404, { requestId: c.requestId });

    const progresso = await importarEmLotes(c.db, c.org.orgId, importId, c.user.id);
    // Uma vez só: quando ESTA chamada foi a que terminou o trabalho.
    if (progresso.status === "done" && progresso.processed > 0) {
      const fim = await resumoDaImportacao(c.db, c.org.orgId, importId);
      c.audita("campaign.imported", id, {
        import_id: importId,
        filename: fim.filename,
        imported: fim.imported,
        rejected: fim.rejected,
        by_reason: fim.by_reason,
      });
    }
    return ok(progresso, { requestId: c.requestId });
  });
}
