/**
 * POST /api/v1/campaigns/[id]/destinations/[destinationId]/activate — TROCAR DESTINO.
 *
 * Torna um destino já cadastrado o ativo. O atual é encerrado (`full` por padrão:
 * "o grupo lotou") e, a partir do instante da troca, só os PRÓXIMOS contatos
 * recebem o novo link. Quem já foi direcionado ao anterior continua contado nele.
 * Trocar para o destino que já é o ativo não faz nada (`changed: false`).
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { ativarDestinoSchema } from "@/lib/campaigns/schemas";
import { trocarDestino } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; destinationId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "trocar_destino", apoio: await requireSupportWrite() }, async (c) => {
    const { id, destinationId } = await params;
    const invalido = idInvalido(c, id, destinationId);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, ativarDestinoSchema, c);
    if (!corpo.ok) return corpo.response;
    const r = await trocarDestino(c.db, c.org.orgId, id, destinationId, c.user.id, {
      expectedCurrent: corpo.data.expected_current,
      closeReason: corpo.data.close_reason,
    });
    if (r.changed) {
      c.audita("campaign.destination_changed", id, {
        to_destination_id: r.destination_id,
        from_destination_id: r.previous_destination_id ?? null,
        close_reason: corpo.data.close_reason,
      });
    }
    return ok(r, { requestId: c.requestId });
  });
}
