/**
 * GET  /api/v1/campaigns — as campanhas da organização, com o placar de cada uma.
 * POST /api/v1/campaigns — cria uma campanha em rascunho (manager+).
 *
 * Central de Disparos. A campanha só começa a enviar quando alguém a INICIA
 * (`POST /campaigns/[id]/transition`, admin) — criar nunca envia nada.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarCampanha, listarCampanhas } from "@/lib/campaigns/service";
import { lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { criarCampanhaSchema } from "@/lib/campaigns/schemas";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const campanhas = await listarCampanhas(c.db, c.org.orgId);
    return ok(campanhas, { requestId: c.requestId });
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return rotaDeCampanha({ acao: "criar", apoio: await requireSupportWrite() }, async (c) => {
    const corpo = await lerCorpo(req, criarCampanhaSchema, c);
    if (!corpo.ok) return corpo.response;
    const id = await criarCampanha(c.db, c.org.orgId, c.user.id, corpo.data);
    c.audita("campaign.created", id, { name: corpo.data.name });
    return ok({ id }, { requestId: c.requestId, status: 201 });
  });
}
