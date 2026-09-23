/**
 * GET /bloquear/<token> — o link "BLOQUEAR CONTATO" que vai na mensagem da campanha.
 *
 * PÚBLICO (sem sessão). Diferente de `/g/<token>`, não redireciona pra lugar nenhum: mostra a
 * confirmação na hora, porque o clique EM SI é o pedido. Vale só PARA ESTA CAMPANHA (decisão do
 * dono do CRM) — nunca impede a pessoa de aparecer numa lista futura, diferente.
 *
 * Só `browser` conta como a pessoa de verdade pedindo (mesma régua do link de clique,
 * `classificarAgente`): a pré-visualização que o WhatsApp desenha do link, e robôs em geral,
 * não bloqueiam ninguém — sem isso, o preview automático bloquearia a pessoa antes dela nem
 * ter visto a mensagem.
 *
 * Token que não existe: nunca finge que bloqueou. Clicar duas vezes: idempotente, mesma tela.
 */
import type { NextRequest } from "next/server";

import { classificarAgente } from "@/lib/campaigns/rastreio";
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
  "Content-Type": "text/html; charset=utf-8",
} as const;

const pagina = (status: number, corpo: string) =>
  new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"><title>Central de Disparos</title></head>` +
      `<body style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; text-align: center;">` +
      `<p style="font-size: 17px;">${corpo}</p></body></html>`,
    { status, headers: CABECALHOS },
  );

const NAO_ENCONTRADO = () => pagina(404, "Não encontramos essa solicitação. O link pode estar errado ou já ter expirado.");
const CONFIRMADO = () => pagina(200, "Pronto — você não vai mais receber mensagens desta campanha.");

async function tratar(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const { token } = await params;
  const classe = classificarAgente(req.headers.get("user-agent"), req.method);

  // Pré-visualização e robô: nunca bloqueiam ninguém. A tela ainda responde (nem consulta o
  // banco), porque não custa nada e evita distinguir "existe" de "não existe" por timing.
  if (classe !== "browser" || req.method.toUpperCase() === "HEAD") {
    return CONFIRMADO();
  }

  const admin = createAdminClient();
  let resultado: string | null = null;
  const { data, error } = await admin.rpc("fn_campaign_block_contact", { p_token: token });
  if (error) {
    logger.error("[bloqueio] não consegui resolver o link", { erro: error.message });
  } else {
    resultado = data as string;
  }

  if (resultado === "unknown" || resultado === null) return NAO_ENCONTRADO();

  // 'ok' e 'already' são o mesmo resultado pra quem está do outro lado: não vai receber mais.
  return CONFIRMADO();
}

export async function GET(req: NextRequest, ctx: RouteParams): Promise<Response> {
  return tratar(req, ctx);
}

export async function HEAD(req: NextRequest, ctx: RouteParams): Promise<Response> {
  return tratar(req, ctx);
}
