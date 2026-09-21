/**
 * POST /api/v1/campaigns/[id]/imports/[importId]/validate — passo 2: mapear e validar.
 *
 * Corpo: o mapeamento de colunas que o operador confirmou (telefone, nome, e-mail e
 * as colunas extras que viram variável). Aplica a regra de telefone da casa a TODAS as
 * linhas e devolve o resumo que a prévia mostra ("45.000 encontrados · 44.732 válidos ·
 * 201 duplicados · 67 inválidos") ANTES de qualquer contato ser criado.
 *
 * Pode ser repetido com outro mapeamento até o operador confirmar a importação.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resumoDaImportacao, validarImportacao } from "@/lib/campaigns/importacao-service";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { mapeamentoSchema } from "@/lib/campaigns/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; importId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "importar", apoio: await requireSupportWrite() }, async (c) => {
    const { id, importId } = await params;
    const invalido = idInvalido(c, id, importId);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, mapeamentoSchema, c);
    if (!corpo.ok) return corpo.response;
    const atual = await resumoDaImportacao(c.db, c.org.orgId, importId);
    if (atual.campaign_id !== id) return fail("not_found", c.t("Não encontrado."), 404, { requestId: c.requestId });
    return ok(await validarImportacao(c.db, c.org.orgId, importId, corpo.data), { requestId: c.requestId });
  });
}
