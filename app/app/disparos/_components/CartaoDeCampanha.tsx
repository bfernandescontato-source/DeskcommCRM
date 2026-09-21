"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useTransicao } from "@/hooks/campaigns/useCampanhas";
import { numero, percentual } from "@/lib/campaigns/formato";
import type { CampanhaResumo } from "@/lib/campaigns/service";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { Pause, Play } from "@/lib/ui/icons";

import { avisarErro, Barra, Girando, SeloDaCampanha, useTexto, pf } from "./pecas";

function Mini({ rotulo, valor, tom }: { rotulo: string; valor: number; tom?: "erro" }) {
  const { t } = useTexto();
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-text-muted">{t(rotulo)}</p>
      <p className={tom === "erro" && valor > 0 ? "text-sm font-semibold tabular-nums text-error-fg" : "text-sm font-semibold tabular-nums"}>{numero(valor)}</p>
    </div>
  );
}

/** A campanha em andamento (ou pausada) na abertura da Central: o placar e as quatro ações do dia a dia. */
export function CartaoDeCampanha({ campanha: c, pode }: { campanha: CampanhaResumo; pode: PermissoesDaCentral }) {
  const { t } = useTexto();
  const transicao = useTransicao(c.id);
  const pausada = c.status === "paused" || c.status === "error";
  const pendentes = c.counts.pending + c.counts.queued + c.counts.processing;
  const feitos = c.counts.sent + c.counts.failed + c.counts.uncertain + c.counts.skipped + c.counts.cancelled;
  const base = `/app/disparos/${c.id}`;

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={base} className="block truncate text-base font-semibold tracking-tight hover:text-accent">
            {c.name}
          </Link>
          <p className="mt-0.5 text-xs text-text-muted">
            {pf(t("{n} de {total} enviados · {pct}"), { n: numero(c.counts.sent), total: numero(c.counts.total), pct: percentual(c.counts.sent, c.counts.total) })}
          </p>
        </div>
        <SeloDaCampanha status={c.status} />
      </header>

      <Barra valor={feitos} total={c.counts.total} />

      <div className="grid grid-cols-5 gap-3">
        <Mini rotulo="Pendentes" valor={pendentes} />
        <Mini rotulo="Cliques" valor={c.counts.clicked} />
        <Mini rotulo="Entradas" valor={c.counts.joined} />
        <Mini rotulo="Respostas" valor={c.counts.replied} />
        <Mini rotulo="Falhas" valor={c.counts.failed + c.counts.uncertain} tom="erro" />
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {pode.pausar ? (
          <Button
            size="sm"
            variant={pausada ? "primary" : "outline"}
            disabled={transicao.isPending}
            onClick={() => transicao.mutate({ action: pausada ? "resume" : "pause" }, { onError: avisarErro })}
          >
            {transicao.isPending ? <Girando className="size-4" /> : pausada ? <Play weight="duotone" /> : <Pause weight="duotone" />}
            {pausada ? t("Retomar") : t("Pausar")}
          </Button>
        ) : null}
        {pode.editar ? (
          <>
            <Button asChild size="sm" variant="outline">
              <Link href={`${base}?aba=mensagens&editar=1`}>{t("Editar mensagem")}</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={`${base}?aba=destinos`}>{t("Trocar grupo")}</Link>
            </Button>
          </>
        ) : null}
        <Button asChild size="sm" variant="ghost" className="ml-auto">
          <Link href={base}>{t("Ver campanha")}</Link>
        </Button>
      </footer>
    </article>
  );
}
