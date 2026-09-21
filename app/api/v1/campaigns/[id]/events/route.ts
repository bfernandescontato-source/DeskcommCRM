/**
 * GET /api/v1/campaigns/[id]/events — a aba Atividade: a linha do tempo da campanha.
 *
 * Mais recentes primeiro, cursor opaco. Com `?contact=<campaign_contact_id>`
 * devolve só a linha do tempo daquele contato (o perfil individual). Somente
 * leitura; a trilha é append-only no banco.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { nomesDeQuemAgiu } from "@/lib/campaigns/leituras";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";
import { eventosQuerySchema } from "@/lib/campaigns/schemas";
import { listarEventos } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const query = eventosQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!query.success) {
      return fail("validation_failed", c.t("Parâmetros inválidos."), 422, {
        requestId: c.requestId,
        details: query.error.flatten().fieldErrors as Record<string, unknown>,
      });
    }
    const { eventos, nextCursor } = await listarEventos(c.db, c.org.orgId, id, {
      cursor: query.data.cursor,
      limit: query.data.limit,
      contactCampaignId: query.data.contact,
    });
    const nomes = await nomesDeQuemAgiu(c.db, c.org.orgId, eventos.map((e) => e.actor_user_id));
    const comAutor = eventos.map((e) => ({ ...e, actor_name: e.actor_user_id ? (nomes.get(e.actor_user_id) ?? null) : null }));
    return ok(comAutor, { requestId: c.requestId, meta: { cursor: nextCursor, has_more: nextCursor !== null } });
  });
}
