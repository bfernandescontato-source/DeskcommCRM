/**
 * GET /api/v1/campaigns/[id]/overview — a Visão geral inteira numa ida só.
 *
 * O bloco "Agora" (o que está acontecendo neste instante), o funil, as métricas por versão,
 * por grupo e por número, e os alertas — tudo calculado da FONTE (as linhas da campanha),
 * nunca de contador agregado. A tela chama isto de poucos em poucos segundos com a campanha
 * aberta e nunca com ela fechada.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { agoraDaCampanha, alertasDaCampanha, metricasDaCampanha, nomesDeQuemAgiu } from "@/lib/campaigns/leituras";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";
import { detalharCampanha } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const [detalhe, metricas, agora, alertas] = await Promise.all([
      detalharCampanha(c.db, c.org.orgId, id),
      metricasDaCampanha(c.db, c.org.orgId, id),
      agoraDaCampanha(c.db, c.org.orgId, id),
      alertasDaCampanha(c.db, c.org.orgId, id),
    ]);
    // Quem criou cada versão: "V3 por Bruno".
    const nomes = await nomesDeQuemAgiu(c.db, c.org.orgId, detalhe.versions.map((v) => v.created_by));
    const versoes = detalhe.versions.map((v) => ({ ...v, created_by_name: v.created_by ? (nomes.get(v.created_by) ?? null) : null }));
    return ok({ ...detalhe, versions: versoes, metrics: metricas, now: agora, alerts: alertas }, { requestId: c.requestId });
  });
}
