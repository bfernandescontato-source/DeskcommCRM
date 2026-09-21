/**
 * POST /api/v1/campaigns/[id]/transition — a máquina de estados da campanha.
 *
 *   ready     draft -> ready                  (manager+)
 *   start     draft|ready -> running          (admin)   o primeiro envio é irreversível
 *   pause     running -> paused               (manager+)
 *   resume    paused|error -> running         (manager+)
 *   complete  running|paused|error -> completed (admin) ENCERRAR: o que não saiu é cancelado
 *   cancel    qualquer não-terminal -> cancelled (admin)
 *
 * Idempotente: pedir o estado em que a campanha já está devolve `changed: false`
 * (duplo clique e retentativa de rede não fazem nada a mais). Quem decide se a
 * transição é válida é o banco; esta rota só confere o papel e audita quando
 * houve efeito.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import type { AuditAction } from "@/lib/audit/actions";
import { papelMinimo } from "@/lib/campaigns/permissoes";
import { idInvalido, lerCorpo, rotaDeCampanha } from "@/lib/campaigns/rota";
import { transicaoSchema, type AcaoDaApi } from "@/lib/campaigns/schemas";
import { transicionar } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const AUDITORIA: Record<AcaoDaApi, AuditAction> = {
  ready: "campaign.ready",
  start: "campaign.started",
  pause: "campaign.paused",
  resume: "campaign.resumed",
  complete: "campaign.completed",
  cancel: "campaign.cancelled",
};

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  // O papel mínimo da ROTA é o menor (manager, o de pausar); as ações que pedem admin
  // são conferidas abaixo, depois de saber qual ação veio no corpo.
  return rotaDeCampanha({ acao: "pause", apoio: await requireSupportWrite() }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const corpo = await lerCorpo(req, transicaoSchema, c);
    if (!corpo.ok) return corpo.response;
    const { action, reason } = corpo.data;

    if (papelMinimo(action) !== papelMinimo("pause")) {
      const negado = await c.exigir(action);
      if (negado) return negado;
    }

    const r = await transicionar(c.db, c.org.orgId, id, c.user.id, action, reason);
    if (r.changed) {
      c.audita(AUDITORIA[action], id, { from: r.from, to: r.to, reason, cancelled_contacts: r.cancelled_contacts });
    }
    return ok(r, { requestId: c.requestId });
  });
}
