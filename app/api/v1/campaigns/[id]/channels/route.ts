/**
 * PUT /api/v1/campaigns/[id]/channels — define QUAIS números enviam esta campanha.
 *
 * O conjunto habilitado passa a ser exatamente o informado. Só números de
 * WhatsApp da própria organização e não arquivados; qualquer outro é recusado.
 * Tirar um número no meio da campanha não perde ninguém da fila: os contatos
 * reservados por ele voltam para `pending` no ponto sem volta.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { canaisSchema } from "@/lib/campaigns/schemas";
import { definirCanais } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "trocar_canais", apoio: await requireSupportWrite() }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, canaisSchema, c);
    if (!corpo.ok) return corpo.response;
    const r = await definirCanais(c.db, c.org.orgId, id, c.user.id, corpo.data.channel_ids);
    if (r.added > 0 || r.removed > 0) c.audita("campaign.channels_changed", id, { added: r.added, removed: r.removed });
    return ok(r, { requestId: c.requestId });
  });
}
