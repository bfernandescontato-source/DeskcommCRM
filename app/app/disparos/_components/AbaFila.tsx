"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useFila, type VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { contextoDeNomes, estadoDoContato, filtroRapidoDoStatus, FILTROS_RAPIDOS, MOTIVO_DE_IGNORADO, numero, rotuloDoCanal } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { PerfilDoContato } from "./PerfilDoContato";
import { ErroNaTela, Selecao, SeloDoContato, SeloDoEnvio, useAtrasado, Vazio, useTexto, useDatas, pf } from "./pecas";

const TODOS = "todos";

export function AbaFila({ v, pode, statusInicial }: { v: VisaoGeral; pode: PermissoesDaCentral; statusInicial: string | null }) {
  const { dataHora } = useDatas();
  const { t } = useTexto();
  const [rapido, setRapido] = React.useState(() => filtroRapidoDoStatus(statusInicial));
  const [busca, setBusca] = React.useState("");
  const [canal, setCanal] = React.useState(TODOS);
  const [versao, setVersao] = React.useState(TODOS);
  const [destino, setDestino] = React.useState(TODOS);
  const [aberto, setAberto] = React.useState<string | null>(null);
  const q = useAtrasado(busca);

  const f = FILTROS_RAPIDOS.find((x) => x.id === rapido)?.filtro ?? {};
  const fila = useFila(v.campaign.id, {
    ...f,
    q: q.trim() || undefined,
    channel: canal === TODOS ? undefined : canal,
    version: versao === TODOS ? undefined : versao,
    destination: destino === TODOS ? undefined : destino,
  });
  const linhas = fila.data?.pages.flatMap((p) => p.linhas) ?? [];
  const nomes = React.useMemo(() => contextoDeNomes(v), [v]);
  const filtrando = rapido !== "todos" || q.trim() !== "" || canal !== TODOS || versao !== TODOS || destino !== TODOS;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <Input aria-label={t("Buscar contato")} placeholder={t("Buscar por nome ou telefone")} className="pl-9" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <Selecao
          rotulo="Número"
          valor={canal}
          aoMudar={setCanal}
          opcoes={[{ valor: TODOS, rotulo: "Todos os números" }, ...v.channels.map((c) => ({ valor: c.channel_session_id, rotulo: rotuloDoCanal(c.session) }))]}
        />
        <Selecao
          rotulo="Versão da mensagem"
          valor={versao}
          aoMudar={setVersao}
          opcoes={[{ valor: TODOS, rotulo: "Todas as versões" }, ...v.versions.map((x) => ({ valor: x.id, rotulo: `V${x.version_no}` }))]}
        />
        <Selecao
          rotulo="Grupo de destino"
          valor={destino}
          aoMudar={setDestino}
          opcoes={[{ valor: TODOS, rotulo: "Todos os grupos" }, ...v.destinations.map((x) => ({ valor: x.id, rotulo: x.name }))]}
        />
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Filtros rápidos")}>
        {FILTROS_RAPIDOS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={rapido === x.id}
            onClick={() => setRapido(x.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              rapido === x.id ? "border-transparent bg-accent text-accent-foreground" : "border-border bg-surface text-text-muted hover:border-accent hover:text-accent",
            )}
          >
            {t(x.rotulo)}
          </button>
        ))}
      </div>

      {fila.error ? <ErroNaTela mensagem={fila.error.message} onTentar={() => void fila.refetch()} /> : null}

      {fila.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg" />
          ))}
        </div>
      ) : linhas.length === 0 ? (
        <Vazio titulo={filtrando ? "Ninguém corresponde a este filtro" : "A fila está vazia"} texto={filtrando ? "Tente limpar a busca ou escolher outro filtro." : "Importe os contatos para começar."} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-elevated text-left text-xs text-text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t("Contato")}</th>
                <th className="px-3 py-2 font-medium">{t("Estado")}</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">{t("Envio")}</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("Número")}</th>
                <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("Versão")}</th>
                <th className="hidden px-3 py-2 font-medium xl:table-cell">{t("Grupo")}</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">{t("Enviado")}</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr
                  key={l.id}
                  tabIndex={0}
                  onClick={() => setAberto(l.id)}
                  onKeyDown={(e) => (e.key === "Enter" ? setAberto(l.id) : undefined)}
                  className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-accent-soft/40 focus-visible:bg-accent-soft/60 focus-visible:outline-hidden"
                >
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{l.name ?? l.phone}</p>
                    {l.name ? <p className="text-xs text-text-muted">{l.phone}</p> : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <SeloDoContato estado={estadoDoContato(l)} />
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    <SeloDoEnvio status={l.status} />
                    {l.status === "skipped" && l.skip_reason ? <p className="mt-0.5 text-xs text-text-muted">{MOTIVO_DE_IGNORADO[l.skip_reason] ?? l.skip_reason}</p> : null}
                    {l.status === "failed" && l.last_error_code ? <p className="mt-0.5 text-xs text-text-muted">{l.last_error_code}</p> : null}
                  </td>
                  <td className="hidden px-3 py-2.5 text-text-muted lg:table-cell">{l.channel ?? "—"}</td>
                  <td className="hidden px-3 py-2.5 tabular-nums text-text-muted lg:table-cell">{l.version_no ? `V${l.version_no}` : "—"}</td>
                  <td className="hidden px-3 py-2.5 text-text-muted xl:table-cell">{l.destination ?? "—"}</td>
                  <td className="hidden px-3 py-2.5 tabular-nums text-text-muted sm:table-cell">{dataHora(l.sent_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>
          {pf(t("{n} de {total} contatos"), { n: numero(linhas.length), total: numero(v.counts.total) })}
          {filtrando ? ` ${t("(com filtro, mostrando os que correspondem)")}` : ""}
        </span>
        {fila.hasNextPage ? (
          <Button size="sm" variant="outline" disabled={fila.isFetchingNextPage} onClick={() => void fila.fetchNextPage()}>
            {fila.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
          </Button>
        ) : null}
      </div>

      <PerfilDoContato campaignId={v.campaign.id} contatoId={aberto} aoFechar={() => setAberto(null)} nomes={nomes} pode={pode} />
    </div>
  );
}
