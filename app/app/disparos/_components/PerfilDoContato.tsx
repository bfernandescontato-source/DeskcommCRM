"use client";

import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { usePerfilDoContato, useResolverIncerto } from "@/hooks/campaigns/useCampanhas";
import { frasesDoEvento, type ContextoDeNomes } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";

import { avisarErro, avisarOk, ConfirmarAcao, ErroNaTela, SeloDoContato, SeloDoEnvio, useTexto, useDatas, pf } from "./pecas";

type Resolucao = "sent" | "retry" | "failed";

const TEXTO_DA_RESOLUCAO: Record<Resolucao, { rotulo: string; titulo: string; texto: string }> = {
  sent: { rotulo: "Foi enviada", titulo: "Confirmar que a mensagem foi enviada?", texto: "Use quando você conferiu no WhatsApp do número e a mensagem está lá. O contato passa a Enviado e não recebe outra." },
  retry: { rotulo: "Tentar de novo", titulo: "Tentar enviar de novo?", texto: "Use quando você conferiu e a mensagem NÃO está lá. O contato volta para a fila. Se ela tinha saído, a pessoa receberá duas vezes." },
  failed: { rotulo: "Não foi enviada", titulo: "Marcar como falha?", texto: "O contato passa a Falhou e não entra mais na fila desta campanha." },
};

/** A ficha de um contato da campanha: o que recebeu, quando, por onde e o que aconteceu depois. */
export function PerfilDoContato({ campaignId, contatoId, aoFechar, nomes, pode }: { campaignId: string; contatoId: string | null; aoFechar: () => void; nomes: ContextoDeNomes; pode: PermissoesDaCentral }) {
  const { dataHora } = useDatas();
  const { t } = useTexto();
  const q = usePerfilDoContato(campaignId, contatoId);
  const resolver = useResolverIncerto(campaignId);
  const [pedindo, setPedindo] = React.useState<Resolucao | null>(null);
  const p = q.data;

  return (
    <Sheet open={contatoId !== null} onOpenChange={(a) => (!a ? aoFechar() : undefined)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{p ? (p.contact.name ?? p.contact.phone) : t("Contato")}</SheetTitle>
          <SheetDescription>{p?.contact.name ? p.contact.phone : t("Ficha do contato na campanha")}</SheetDescription>
        </SheetHeader>

        {q.isLoading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : q.error ? (
          <div className="mt-6">
            <ErroNaTela mensagem={q.error.message} onTentar={() => void q.refetch()} />
          </div>
        ) : p ? (
          <div className="mt-5 flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <SeloDoContato estado={p.state} />
              <SeloDoEnvio status={p.status} />
            </div>

            {p.status === "uncertain" && pode.resolverIncerto ? (
              <div className="rounded-lg border border-warning-fg/30 bg-warning-bg p-3 text-sm text-warning-fg">
                <p className="font-medium">{t("Não dá para saber se esta mensagem saiu.")}</p>
                <p className="mt-1 text-xs">{pf(t("O envio foi interrompido antes da confirmação. Confira no WhatsApp do número {canal} e decida — o sistema nunca reenvia sozinho."), { canal: p.channel ? `(${p.channel})` : "" })}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(Object.keys(TEXTO_DA_RESOLUCAO) as Resolucao[]).map((r) => (
                    <Button key={r} size="sm" variant="outline" className="bg-surface text-text" onClick={() => setPedindo(r)}>
                      {t(TEXTO_DA_RESOLUCAO[r].rotulo)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
              <Linha k="Número" v={p.channel} />
              <Linha k="Versão" v={p.version_no ? `V${p.version_no}` : null} />
              <Linha k="Grupo" v={p.destination} />
              <Linha k="Enviado em" v={p.sent_at ? dataHora(p.sent_at) : null} />
              <Linha k="Tentativas" v={String(p.attempts)} />
              {p.last_error_code ? <Linha k="Erro" v={p.last_error_code} /> : null}
              <Linha k="Importado de" v={p.import_filename ? `${p.import_filename} · ${dataHora(p.imported_at)}` : dataHora(p.imported_at)} />
            </dl>

            {p.message?.body ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold text-text-muted">{t("Mensagem enviada")}</h3>
                <p className="whitespace-pre-wrap rounded-lg border border-border bg-surface-elevated p-3 text-sm">{p.message.body}</p>
                <Button asChild size="sm" variant="ghost" className="mt-1.5 px-0">
                  <Link href={`/app/inbox?id=${p.message.conversation_id}`}>{t("Abrir a conversa no Inbox")}</Link>
                </Button>
              </section>
            ) : null}

            {Object.keys(p.variables).length > 0 ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold text-text-muted">{t("Dados do CSV")}</h3>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
                  {Object.entries(p.variables).map(([k, val]) => (
                    <Linha key={k} k={k} v={val} />
                  ))}
                </dl>
              </section>
            ) : null}

            <section>
              <h3 className="mb-2 text-xs font-semibold text-text-muted">{t("Linha do tempo")}</h3>
              <ol className="relative space-y-3 border-l border-border pl-4">
                <Marco quando={p.imported_at} texto={t("Importado na campanha")} />
                {p.events.map((e) => (
                  <Marco key={e.id} quando={e.occurred_at} texto={frasesDoEvento(e, nomes, t)} />
                ))}
              </ol>
            </section>
          </div>
        ) : null}

        {pedindo ? (
          <ConfirmarAcao
            aberto
            aoFechar={() => setPedindo(null)}
            titulo={TEXTO_DA_RESOLUCAO[pedindo].titulo}
            texto={TEXTO_DA_RESOLUCAO[pedindo].texto}
            rotuloDoBotao={TEXTO_DA_RESOLUCAO[pedindo].rotulo}
            ocupado={resolver.isPending}
            aoConfirmar={() =>
              contatoId
                ? resolver.mutate(
                    { contactId: contatoId, resolution: pedindo },
                    {
                      onSuccess: () => {
                        avisarOk(t("Registrado."));
                        setPedindo(null);
                      },
                      onError: (e) => {
                        avisarErro(e);
                        setPedindo(null);
                      },
                    },
                  )
                : undefined
            }
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Linha({ k, v }: { k: string; v: string | null }) {
  const { t } = useTexto();
  return (
    <>
      <dt className="text-text-muted">{t(k)}</dt>
      <dd className="min-w-0 break-words font-medium">{v ?? "—"}</dd>
    </>
  );
}

function Marco({ quando, texto }: { quando: string; texto: string }) {
  const { dataHora } = useDatas();
  return (
    <li className="relative">
      <span className="absolute -left-[1.3rem] top-1.5 size-2 rounded-full bg-accent" aria-hidden />
      <p className="text-sm">{texto}</p>
      <p className="text-xs text-text-muted">{dataHora(quando)}</p>
    </li>
  );
}
