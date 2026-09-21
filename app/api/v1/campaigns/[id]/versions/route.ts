/**
 * POST /api/v1/campaigns/[id]/versions — nova versão da mensagem.
 *
 * Funciona com a campanha rodando. `activate: true` (padrão) faz a nova versão
 * valer para os PRÓXIMOS contatos da fila; quem já recebeu a anterior guarda a
 * versão que recebeu — nunca se reescreve o histórico. `activate: false` só
 * guarda a versão ("Aplicar aos próximos contatos?" respondido com não).
 *
 * `based_on_version_no` é a última versão que a tela viu: se outra pessoa criou
 * uma depois, a rota responde 409 `version_conflict` (com `current_version_no`)
 * em vez de sobrescrever em silêncio.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { chavesSoltas, variaveisDaMensagem } from "@/lib/campaigns/mensagem";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { versaoSchema } from "@/lib/campaigns/schemas";
import { criarVersao } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "editar_mensagem", apoio: await requireSupportWrite() }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, versaoSchema, c);
    if (!corpo.ok) return corpo.response;

    // `{{nome}` (chave não fechada) iria literal para milhares de pessoas.
    if (chavesSoltas(corpo.data.body)) {
      return fail("validation_failed", c.t("Há uma variável mal formada. Use o formato {{nome}}."), 422, {
        requestId: c.requestId,
        details: { body: ["malformed_variable"] },
      });
    }

    const r = await criarVersao(c.db, c.org.orgId, id, c.user.id, corpo.data);
    c.audita("campaign.version_created", id, {
      version_no: r.version_no,
      previous_version_no: r.previous_version_no,
      activated: r.activated,
      variables: variaveisDaMensagem(corpo.data.body),
    });
    return ok(r, { requestId: c.requestId, status: 201 });
  });
}
