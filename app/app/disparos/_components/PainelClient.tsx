"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePainel } from "@/hooks/campaigns/useCampanhas";
import { numero } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { ArrowSquareOut, ChatCircle, ClockCountdown, Megaphone, PaperPlaneTilt, Plus, Users, WarningOctagon } from "@/lib/ui/icons";

import { CartaoDeCampanha } from "./CartaoDeCampanha";
import { CartaoDeMetrica, ErroNaTela, ListaDeAlertas, SeloDaCampanha, Vazio, useTexto, useDatas, pf } from "./pecas";

export function PainelClient({ pode }: { pode: PermissoesDaCentral }) {
  const { dataHora } = useDatas();
  const { t } = useTexto();
  const q = usePainel();
  const painel = q.data?.panel;
  const carregando = q.isLoading;
  const campanhas = q.data?.campaigns ?? [];
  const ativas = campanhas.filter((c) => c.status === "running" || c.status === "paused" || c.status === "error");
  const demais = campanhas.filter((c) => !ativas.includes(c));
  const ativo = painel?.active ?? {};
  const falhas = ativo.failed ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <CartaoDeMetrica carregando={carregando} rotulo="Em andamento" valor={numero(painel?.running)} dica={painel && painel.paused > 0 ? pf(t(painel.paused > 1 ? "{n} pausadas" : "{n} pausada"), { n: numero(painel.paused) }) : undefined} icone={Megaphone} tom="sucesso" />
        <CartaoDeMetrica carregando={carregando} rotulo="Enviados hoje" valor={numero(painel?.sent_today)} icone={PaperPlaneTilt} />
        <CartaoDeMetrica carregando={carregando} rotulo="Pendentes" valor={numero(ativo.pending ?? 0)} dica="nas campanhas ativas" icone={ClockCountdown} tom="info" />
        <CartaoDeMetrica carregando={carregando} rotulo="Cliques" valor={numero(ativo.clicked ?? 0)} dica="no link do grupo" icone={ArrowSquareOut} />
        <CartaoDeMetrica carregando={carregando} rotulo="Entradas nos grupos" valor={numero(ativo.joined ?? 0)} dica="só grupos monitorados" icone={Users} tom="sucesso" />
        <CartaoDeMetrica carregando={carregando} rotulo="Respostas" valor={numero(ativo.replied ?? 0)} icone={ChatCircle} />
        <CartaoDeMetrica carregando={carregando} rotulo="Falhas" valor={numero(falhas)} dica={falhas > 0 ? "precisam de atenção" : undefined} icone={WarningOctagon} tom={falhas > 0 ? "erro" : "neutro"} />
      </div>

      {q.error ? <ErroNaTela mensagem={q.error.message} onTentar={() => void q.refetch()} /> : null}

      {(q.data?.alerts ?? []).map((g) => (
        <ListaDeAlertas key={g.campaign_id} campaignId={g.campaign_id} campanha={g.campaign_name} alertas={g.alerts} />
      ))}

      <section aria-labelledby="ativas" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 id="ativas" className="text-sm font-semibold">
            {t("Campanhas ativas")}
          </h2>
          {pode.criar ? (
            <Button asChild size="sm">
              <Link href="/app/disparos/nova">
                <Plus weight="bold" /> {t("Nova campanha")}
              </Link>
            </Button>
          ) : null}
        </div>
        {carregando ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <Skeleton className="h-44 w-full rounded-xl" />
            <Skeleton className="h-44 w-full rounded-xl" />
          </div>
        ) : ativas.length === 0 ? (
          <Vazio
            titulo="Nenhuma campanha em andamento"
            texto={campanhas.length === 0 ? "Crie a primeira: importe os contatos, escreva a mensagem, escolha o grupo e os números." : "As campanhas iniciadas aparecem aqui, com o placar ao vivo."}
            acao={
              pode.criar ? (
                <Button asChild size="sm">
                  <Link href="/app/disparos/nova">{t("Criar campanha")}</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {ativas.map((c) => (
              <CartaoDeCampanha key={c.id} campanha={c} pode={pode} />
            ))}
          </div>
        )}
      </section>

      {demais.length > 0 ? (
        <section aria-labelledby="demais" className="flex flex-col gap-3">
          <h2 id="demais" className="text-sm font-semibold">
            {t("Outras campanhas")}
          </h2>
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-elevated text-left text-xs text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("Campanha")}</th>
                  <th className="px-4 py-2 font-medium">{t("Estado")}</th>
                  <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">{t("Contatos")}</th>
                  <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">{t("Enviados")}</th>
                  <th className="hidden px-4 py-2 font-medium md:table-cell">{t("Criada em")}</th>
                </tr>
              </thead>
              <tbody>
                {demais.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent-soft/40">
                    <td className="px-4 py-2.5">
                      <Link href={c.status === "draft" ? `/app/disparos/nova?id=${c.id}` : `/app/disparos/${c.id}`} className="font-medium hover:text-accent">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <SeloDaCampanha status={c.status} />
                    </td>
                    <td className="hidden px-4 py-2.5 text-right tabular-nums sm:table-cell">{numero(c.counts.total)}</td>
                    <td className="hidden px-4 py-2.5 text-right tabular-nums sm:table-cell">{numero(c.counts.sent)}</td>
                    <td className="hidden px-4 py-2.5 text-text-muted md:table-cell">{dataHora(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
