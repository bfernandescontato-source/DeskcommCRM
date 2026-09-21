/**
 * GET /api/v1/campaigns/[id]/contacts/[contactId] — o perfil de UM contato na campanha.
 *
 * A linha do tempo dele (importado, enviado, clicou, respondeu, entrou, saiu), o número que
 * enviou, a versão e o grupo, as tentativas e falhas, o texto exato que recebeu e a conversa
 * do Inbox onde a resposta dele cai. `contactId` aqui é o id da linha na campanha.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { perfilDoContato } from "@/lib/campaigns/leituras";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; contactId: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const { id, contactId } = await params;
    const invalido = idInvalido(c, id, contactId);
    if (invalido) return invalido;
    return ok(await perfilDoContato(c.db, c.org.orgId, id, contactId), { requestId: c.requestId });
  });
}
