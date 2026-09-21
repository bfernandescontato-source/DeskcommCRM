/**
 * GET/POST /api/v1/cron/campaign-dispatcher — o envio das campanhas da Central de Disparos.
 *
 * Roda a cada minuto (serviço `scheduler`). Cada rodada:
 *   1. devolve à fila o contato cuja reserva venceu e marca INCERTO o que estava em envio
 *      (nunca reenvia sozinho);
 *   2. pausa a campanha cujo número caiu (a política é da campanha);
 *   3. por número, se o ritmo permite, envia UM contato — pelo mesmo caminho de saída do
 *      Inbox, para a resposta cair na conversa que já existe;
 *   4. encerra a campanha que não tem mais nada por processar.
 *
 * NÃO guarda estado: o banco é a fonte da verdade. Reiniciar o app, a VPS ou este worker no
 * meio de uma rodada não perde posição nem repete envio. Ritmo (janela, aquecimento, teto
 * diário, intervalo fixo) em `lib/campaigns/ritmo.ts` — sem jitter, de propósito.
 *
 * Rodada que não fez nada não é mutação e não audita; pausa automática audita (dentro de
 * `despachante-producao`, só quando houve efeito).
 *
 * Auth: Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET (fail-closed), como os demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { despachar } from "@/lib/campaigns/despachante";
import { depsDeProducao } from "@/lib/campaigns/despachante-producao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });

  const admin = createAdminClient();
  try {
    const resumo = await despachar(depsDeProducao(admin));

    // Faxina das linhas cruas de importação abandonadas: uma vez por hora basta.
    if (new Date().getUTCMinutes() === 30) {
      const { error } = await admin.rpc("fn_campaign_import_purge", { p_days: 30 });
      if (error) logger.warn("[campaign-dispatcher] faxina de importações falhou", { requestId, erro: error.message });
    }
    return ok(resumo, { requestId });
  } catch (err) {
    logger.error("[campaign-dispatcher] falhou", { requestId, erro: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", "Failed to dispatch campaigns.", 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
