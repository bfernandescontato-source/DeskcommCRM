/**
 * POST /api/v1/campaigns/[id]/contacts/[contactId]/resolve — decidir um envio INCERTO.
 *
 * Quando o servidor não consegue saber se a mensagem saiu (o processo caiu no meio, o canal
 * demorou a responder), o contato fica incerto e NUNCA é reenviado sozinho. Uma pessoa olha a
 * conversa e diz: `sent` (saiu), `retry` (não saiu, tentar de novo na mesma posição da fila)
 * ou `failed` (não saiu e não vale tentar). Repetir a mesma decisão é inofensivo.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolverIncerto } from "@/lib/campaigns/leituras";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { resolverIncertoSchema } from "@/lib/campaigns/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; contactId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "resolver_incerto", apoio: await requireSupportWrite() }, async (c) => {
    const { id, contactId } = await params;
    const invalido = idInvalido(c, id, contactId);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, resolverIncertoSchema, c);
    if (!corpo.ok) return corpo.response;
    const r = await resolverIncerto(c.db, c.org.orgId, contactId, corpo.data.resolution, c.user.id);
    if (r === "not_uncertain") {
      return fail("not_uncertain", c.t("Este envio não está incerto."), 409, { requestId: c.requestId });
    }
    return ok({ result: r }, { requestId: c.requestId });
  });
}
