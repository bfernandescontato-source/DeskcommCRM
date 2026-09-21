"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTransicao, useVisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { acoesDaCampanha, MOTIVO_DA_PAUSA } from "@/lib/campaigns/formato";
import { podeFazer, type PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { CaretLeft } from "@/lib/ui/icons";

import { AbaAtividade } from "./AbaAtividade";
import { AbaDestinos } from "./AbaDestinos";
import { AbaFila } from "./AbaFila";
import { AbaMensagens } from "./AbaMensagens";
import { AbaVisaoGeral } from "./AbaVisaoGeral";
import { avisarErro, BotaoDeAcao, ErroNaTela, ListaDeAlertas, SeloDaCampanha, useTexto, pf } from "./pecas";

const ABAS = [
  { id: "visao", rotulo: "Visão geral" },
  { id: "fila", rotulo: "Fila" },
  { id: "mensagens", rotulo: "Mensagens" },
  { id: "destinos", rotulo: "Destinos" },
  { id: "atividade", rotulo: "Atividade" },
] as const;
type IdDaAba = (typeof ABAS)[number]["id"];

export function CampanhaClient({ id, pode }: { id: string; pode: PermissoesDaCentral }) {
  const { t } = useTexto();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const aba: IdDaAba = ABAS.find((a) => a.id === params.get("aba"))?.id ?? "visao";
  const q = useVisaoGeral(id);
  const transicao = useTransicao(id);

  const irPara = (nova: string) => router.replace(`${pathname}?aba=${nova}`, { scroll: false });

  if (q.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="flex flex-col gap-4">
        <Voltar />
        <ErroNaTela mensagem={q.error?.message ?? "Campanha não encontrada."} onTentar={() => void q.refetch()} />
      </div>
    );
  }

  const v = q.data;
  const c = v.campaign;
  const rascunho = c.status === "draft" || c.status === "ready";
  const acoes = acoesDaCampanha(c.status).filter((a) => podeFazer(pode, a.acao));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Voltar />
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{c.name}</h1>
              <SeloDaCampanha status={c.status} />
            </div>
            {c.status === "paused" || c.status === "error" ? (
              <p className="mt-1 text-sm text-text-muted">
                {pf(t("{motivo}. A fila continua exatamente de onde parou."), { motivo: t(MOTIVO_DA_PAUSA[c.status_reason ?? "manual"] ?? c.status_reason ?? "pausada") })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {rascunho && pode.editar ? (
              <Button asChild variant="outline">
                <Link href={`/app/disparos/nova?id=${c.id}`}>{t("Continuar configuração")}</Link>
              </Button>
            ) : null}
            {acoes.map((a) => (
              <BotaoDeAcao
                key={a.acao}
                acao={a}
                ocupado={transicao.isPending}
                aoExecutar={(x) => transicao.mutate({ action: x.acao }, { onError: avisarErro })}
              />
            ))}
          </div>
        </header>
      </div>

      <ListaDeAlertas campaignId={c.id} alertas={v.alerts} />

      <Tabs value={aba} onValueChange={irPara}>
        <TabsList>
          {ABAS.map((a) => (
            <TabsTrigger key={a.id} value={a.id}>
              {t(a.rotulo)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {aba === "visao" ? <AbaVisaoGeral v={v} pode={pode} /> : null}
      {aba === "fila" ? <AbaFila v={v} pode={pode} statusInicial={params.get("status")} /> : null}
      {aba === "mensagens" ? <AbaMensagens v={v} pode={pode} abrirEdicao={params.get("editar") === "1"} /> : null}
      {aba === "destinos" ? <AbaDestinos v={v} pode={pode} /> : null}
      {aba === "atividade" ? <AbaAtividade v={v} /> : null}
    </div>
  );
}

function Voltar() {
  const { t } = useTexto();
  return (
    <Link href="/app/disparos" className="inline-flex w-fit items-center gap-1 text-sm text-text-muted hover:text-accent">
      <CaretLeft className="size-4" aria-hidden /> {t("Disparos")}
    </Link>
  );
}
