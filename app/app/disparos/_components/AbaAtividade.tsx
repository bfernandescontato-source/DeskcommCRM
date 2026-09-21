"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAtividade, type VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { contextoDeNomes, frasesDoEvento } from "@/lib/campaigns/formato";

import { ErroNaTela, Vazio, useTexto, useDatas } from "./pecas";

/** O diário da campanha: quem fez o quê e quando. Só a campanha por padrão; os envios individuais são opcionais. */
export function AbaAtividade({ v }: { v: VisaoGeral }) {
  const { dataHora } = useDatas();
  const { t } = useTexto();
  const [comEnvios, setComEnvios] = React.useState(false);
  const q = useAtividade(v.campaign.id, comEnvios);
  const nomes = React.useMemo(() => contextoDeNomes(v), [v]);
  const eventos = q.data?.pages.flatMap((p) => p.eventos) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-text-muted">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={comEnvios} onChange={(e) => setComEnvios(e.target.checked)} />
        {t("Incluir cada envio, clique e resposta (pode ser muita coisa)")}
      </label>

      {q.error ? <ErroNaTela mensagem={q.error.message} onTentar={() => void q.refetch()} /> : null}

      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : eventos.length === 0 ? (
        <Vazio titulo="Nada registrado ainda" texto="Iniciar, pausar, trocar a mensagem ou o grupo: tudo aparece aqui, com quem fez." />
      ) : (
        <ol className="divide-y divide-border rounded-xl border border-border bg-surface">
          {eventos.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm">
              <span className="min-w-0">{frasesDoEvento(e, nomes, t)}</span>
              <time dateTime={e.occurred_at} className="shrink-0 text-xs tabular-nums text-text-muted">
                {dataHora(e.occurred_at)}
              </time>
            </li>
          ))}
        </ol>
      )}

      {q.hasNextPage ? (
        <Button className="self-center" size="sm" variant="outline" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? t("Carregando…") : t("Ver mais antigos")}
        </Button>
      ) : null}
    </div>
  );
}
