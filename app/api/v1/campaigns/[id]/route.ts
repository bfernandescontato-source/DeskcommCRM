/**
 * GET   /api/v1/campaigns/[id] — a campanha inteira: versões, destinos, números e placar.
 * PATCH /api/v1/campaigns/[id] — nome, rastreio e política de canal (manager+).
 *
 * Mudança de configuração é auditada com antes/depois.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { atualizarConfiguracao, detalharCampanha } from "@/lib/campaigns/service";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { atualizarCampanhaSchema } from "@/lib/campaigns/schemas";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    return ok(await detalharCampanha(c.db, c.org.orgId, id), { requestId: c.requestId });
  });
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "configurar", apoio: await requireSupportWrite() }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, atualizarCampanhaSchema, c);
    if (!corpo.ok) return corpo.response;
    const r = await atualizarConfiguracao(c.db, c.org.orgId, id, c.user.id, corpo.data);
    if (r.changed) c.audita("campaign.updated", id, { changes: r.changes });
    return ok(r, { requestId: c.requestId });
  });
}
