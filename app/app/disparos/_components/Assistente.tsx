"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useVisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { revisaoDaCampanha, usaLinkDoGrupo } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { CaretLeft, CaretRight, Check } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { ErroNaTela, useTexto } from "./pecas";
import { PassoContatos, PassoNome } from "./PassoContatos";
import { PassoDestino, PassoEnvio, PassoMensagem, PassoRevisao } from "./PassosDoAssistente";

const PASSOS = [
  { id: "contatos", rotulo: "Contatos" },
  { id: "mensagem", rotulo: "Mensagem" },
  { id: "destino", rotulo: "Destino" },
  { id: "envio", rotulo: "Envio" },
  { id: "revisao", rotulo: "Revisão" },
] as const;
type IdDoPasso = (typeof PASSOS)[number]["id"];

/**
 * O assistente de 5 passos. A campanha nasce como rascunho no primeiro passo e o id vai para a URL:
 * tudo o que a pessoa fez fica no servidor, então atualizar a página, fechar a aba ou voltar amanhã
 * retoma do mesmo ponto. O passo atual e a importação em andamento também moram na URL.
 */
export function Assistente({ pode }: { pode: PermissoesDaCentral }) {
  const { t } = useTexto();
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const importId = params.get("imp");
  const passo: IdDoPasso = PASSOS.find((p) => p.id === params.get("passo"))?.id ?? "contatos";
  const q = useVisaoGeral(id);

  const ir = (proximo: IdDoPasso, imp: string | null = importId) => {
    const p = new URLSearchParams({ id, passo: proximo });
    if (imp) p.set("imp", imp);
    router.replace(`/app/disparos/nova?${p}`, { scroll: false });
  };

  if (id === "") {
    return (
      <div className="flex max-w-2xl flex-col gap-5">
        <Cabecalho titulo="Nova campanha" />
        <PassoNome aoCriar={(novo) => router.replace(`/app/disparos/nova?id=${novo}&passo=contatos`, { scroll: false })} />
      </div>
    );
  }

  if (q.isLoading) return <Skeleton className="h-64 w-full max-w-3xl rounded-xl" />;
  if (q.error || !q.data) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Cabecalho titulo="Nova campanha" />
        <ErroNaTela mensagem={q.error?.message ?? "Campanha não encontrada."} onTentar={() => void q.refetch()} />
      </div>
    );
  }

  const v = q.data;
  const c = v.campaign;
  if (c.status !== "draft" && c.status !== "ready") {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Cabecalho titulo={c.name} />
        <p className="text-sm text-text-muted">{t("Esta campanha já foi iniciada e não é mais editada por aqui.")}</p>
        <Button asChild className="w-fit">
          <Link href={`/app/disparos/${c.id}`}>{t("Abrir a campanha")}</Link>
        </Button>
      </div>
    );
  }

  const corpo = v.versions.find((x) => x.id === c.active_version_id)?.body ?? null;
  const itens = revisaoDaCampanha({ pendentes: v.counts.pending, corpoAtivo: corpo, temDestinoAtivo: c.active_destination_id !== null, numerosEscolhidos: v.channels.filter((x) => x.enabled).length });
  const feito: Record<IdDoPasso, boolean> = {
    contatos: itens[0]!.ok,
    mensagem: itens[1]!.ok,
    destino: c.active_destination_id !== null || (!usaLinkDoGrupo(corpo) && corpo !== null && v.destinations.length > 0),
    envio: itens[3]!.ok,
    revisao: c.status === "ready",
  };
  const indice = PASSOS.findIndex((p) => p.id === passo);
  const anterior = PASSOS[indice - 1];
  const seguinte = PASSOS[indice + 1];

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Cabecalho titulo={c.name} />

      <nav aria-label={t("Passos")} className="flex flex-wrap items-center gap-1.5">
        {PASSOS.map((p, i) => (
          <button
            key={p.id}
            type="button"
            aria-current={p.id === passo ? "step" : undefined}
            onClick={() => ir(p.id)}
            className={cn(
              "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
              p.id === passo ? "border-transparent bg-accent text-accent-foreground" : "border-border bg-surface text-text-muted hover:border-accent hover:text-accent",
            )}
          >
            <span className={cn("flex size-5 items-center justify-center rounded-full text-[11px] font-semibold", p.id === passo ? "bg-white/25" : feito[p.id] ? "bg-success-bg text-success-fg" : "bg-border")}>
              {feito[p.id] ? <Check weight="bold" className="size-3" aria-hidden /> : i + 1}
            </span>
            {t(p.rotulo)}
          </button>
        ))}
      </nav>

      {passo === "contatos" ? (
        <PassoContatos
          v={v}
          importId={importId}
          aoMudarImportacao={(novo) => {
            const p = new URLSearchParams({ id, passo: "contatos" });
            if (novo) p.set("imp", novo);
            router.replace(`/app/disparos/nova?${p}`, { scroll: false });
          }}
        />
      ) : null}
      {passo === "mensagem" ? <PassoMensagem v={v} aoSalvar={() => ir("destino")} /> : null}
      {passo === "destino" ? <PassoDestino v={v} /> : null}
      {passo === "envio" ? <PassoEnvio v={v} /> : null}
      {passo === "revisao" ? <PassoRevisao v={v} pode={pode} aoIniciar={() => router.push(`/app/disparos/${c.id}`)} /> : null}

      <div className="flex items-center justify-between border-t border-border pt-4">
        {anterior ? (
          <Button variant="ghost" onClick={() => ir(anterior.id)}>
            <CaretLeft /> {t(anterior.rotulo)}
          </Button>
        ) : (
          <span />
        )}
        {seguinte ? (
          <Button variant="outline" onClick={() => ir(seguinte.id)}>
            {t(seguinte.rotulo)} <CaretRight />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Cabecalho({ titulo }: { titulo: string }) {
  const { t } = useTexto();
  return (
    <header className="flex flex-col gap-1">
      <Link href="/app/disparos" className="inline-flex w-fit items-center gap-1 text-sm text-text-muted hover:text-accent">
        <CaretLeft className="size-4" aria-hidden /> {t("Disparos")}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{titulo}</h1>
    </header>
  );
}
