/**
 * POST /api/v1/campaigns/[id]/destinations — cadastra um grupo de destino.
 *
 * Com `activate: true` já o torna o destino ativo ("cadastrar e trocar"): o
 * anterior é encerrado e os PRÓXIMOS contatos recebem o novo link. Sem
 * reiniciar a campanha, sem reimportar o CSV, sem duplicar ninguém.
 *
 * `expected_current` é o destino que a tela achava ser o ativo; se outra pessoa
 * já trocou, a rota responde 409 `destination_conflict`.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { destinoSchema } from "@/lib/campaigns/schemas";
import { cadastrarDestino } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "trocar_destino", apoio: await requireSupportWrite() }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, destinoSchema, c);
    if (!corpo.ok) return corpo.response;
    const r = await cadastrarDestino(c.db, c.org.orgId, id, c.user.id, corpo.data);
    c.audita("campaign.destination_added", id, {
      destination_id: r.destination_id,
      name: corpo.data.name,
      capacity: corpo.data.capacity ?? null,
      activated: r.activated,
    });
    if (r.switch?.changed) {
      c.audita("campaign.destination_changed", id, {
        to_destination_id: r.destination_id,
        from_destination_id: r.switch.previous_destination_id ?? null,
        to_name: corpo.data.name,
      });
    }
    return ok(r, { requestId: c.requestId, status: 201 });
  });
}
