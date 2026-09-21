/**
 * GET /g/<token> — o link rastreável que vai na mensagem da campanha.
 *
 * PÚBLICO (sem sessão): quem clica é uma pessoa de fora. Faz exatamente três coisas:
 *   1. resolve o token no banco (um índice único) — token que não existe, que nunca foi
 *      entregue ou que não tem o formato responde 404, e NUNCA redireciona para lugar nenhum;
 *   2. redireciona NA HORA (302) para o convite do destino — o visitante não espera escrita;
 *   3. DEPOIS de responder, registra o clique (`after`). Falha ao registrar nunca afeta quem clicou.
 *
 * Só `browser` conta como pessoa; a pré-visualização do WhatsApp e os robôs ficam gravados mas
 * não contam (`classificarAgente`). O destino é conferido de novo aqui (`destinoSeguro`): só
 * convite de WhatsApp em https, para o domínio do cliente nunca virar redirecionamento aberto.
 *
 * Sem IP e sem user-agent gravados. `Referrer-Policy: no-referrer` para o destino não receber
 * o token; `no-store` para nada guardar a resposta; HEAD nunca registra clique.
 */
import { after, type NextRequest } from "next/server";

import { classificarAgente, destinoSeguro, type AlvoDoClique } from "@/lib/campaigns/rastreio";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ token: string }>;
}

const CABECALHOS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

async function tratar(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const { token } = await params;
  const naoEncontrado = () =>
    new Response("Link inválido ou expirado.", { status: 404, headers: { ...CABECALHOS, "Content-Type": "text/plain; charset=utf-8" } });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_campaign_click_target", { p_token: token });
  if (error) {
    logger.error("[rastreio] não consegui resolver o link", { erro: error.message });
    return naoEncontrado();
  }
  const alvo = data as AlvoDoClique | null;
  if (!destinoSeguro(alvo)) return naoEncontrado();

  const classe = classificarAgente(req.headers.get("user-agent"), req.method);
  // HEAD só confere o link: não é clique de ninguém.
  if (req.method.toUpperCase() !== "HEAD") {
    after(async () => {
      const { error: erroDoRegistro } = await admin.rpc("fn_campaign_record_click", {
        p_token: token,
        p_destination: alvo.destination_id,
        p_from_destination: alvo.from_destination_id,
        p_agent_class: classe,
      });
      if (erroDoRegistro) logger.warn("[rastreio] não consegui registrar o clique", { erro: erroDoRegistro.message });
    });
  }
  return new Response(null, { status: 302, headers: { ...CABECALHOS, Location: alvo.url } });
}

export async function GET(req: NextRequest, ctx: RouteParams): Promise<Response> {
  return tratar(req, ctx);
}

export async function HEAD(req: NextRequest, ctx: RouteParams): Promise<Response> {
  return tratar(req, ctx);
}
