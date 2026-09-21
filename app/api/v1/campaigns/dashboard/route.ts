/**
 * GET /api/v1/campaigns/dashboard — a abertura da Central de Disparos.
 *
 * Os sete números do topo (em andamento, enviados hoje, pendentes, cliques, entradas,
 * respostas, falhas), as campanhas que estão rodando ou pausadas com o placar de cada uma e
 * os alertas que exigem atenção. Só o que vale a pena olhar; nada de gráfico.
 */
import { ok } from "@/lib/api/wrappers";
import { alertasDaCampanha, painelGeral } from "@/lib/campaigns/leituras";
import { rotaDeCampanha } from "@/lib/campaigns/rota";
import { listarCampanhas } from "@/lib/campaigns/service";

export const dynamic = "force-dynamic";

/** Quantas campanhas ativas trazem alerta calculado (cada uma custa uma agregação). */
const MAX_COM_ALERTA = 10;

export async function GET(): Promise<Response> {
  return rotaDeCampanha({ acao: "ler" }, async (c) => {
    const [painel, campanhas] = await Promise.all([painelGeral(c.db, c.org.orgId), listarCampanhas(c.db, c.org.orgId, 100)]);
    const ativas = campanhas.filter((x) => x.status === "running" || x.status === "paused").slice(0, MAX_COM_ALERTA);
    const alertas = await Promise.all(
      ativas.map(async (x) => ({ campaign_id: x.id, campaign_name: x.name, alerts: await alertasDaCampanha(c.db, c.org.orgId, x.id) })),
    );
    return ok(
      {
        panel: painel,
        campaigns: campanhas,
        alerts: alertas.filter((a) => a.alerts.length > 0),
      },
      { requestId: c.requestId },
    );
  });
}
