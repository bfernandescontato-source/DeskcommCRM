"use client";

import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErroDaCentral } from "@/hooks/campaigns/api";
import { chaves, useCriarVersao, type VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { numero, percentual } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { PencilSimple } from "@/lib/ui/icons";

import { CampoDaMensagem, useEditorDeMensagem } from "./EditorDeMensagem";
import { avisarErro, avisarOk, ConfirmarAcao, Girando, Secao, useTexto, useDatas, pf } from "./pecas";

export function AbaMensagens({ v, pode, abrirEdicao }: { v: VisaoGeral; pode: PermissoesDaCentral; abrirEdicao: boolean }) {
  const { dataHora } = useDatas();
  const { t } = useTexto();
  const aberta = v.campaign.status !== "completed" && v.campaign.status !== "cancelled";
  const [editando, setEditando] = React.useState(abrirEdicao && pode.editar && aberta);
  const ativa = v.versions.find((x) => x.id === v.campaign.active_version_id) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-muted">
          {t("Cada alteração cria uma nova versão. Quem já recebeu continua com a versão que recebeu; só os próximos contatos da fila recebem a nova.")}
        </p>
        {pode.editar && aberta ? (
          <Button onClick={() => setEditando(true)}>
            <PencilSimple weight="duotone" /> {ativa ? t("Editar mensagem") : t("Escrever mensagem")}
          </Button>
        ) : null}
      </div>

      {v.versions.length === 0 ? (
        <Secao titulo="Nenhuma mensagem ainda">
          <p className="text-sm text-text-muted">{t("Escreva a mensagem para poder iniciar a campanha. Use {{nome}} e {{link_grupo}} para personalizar.")}</p>
        </Secao>
      ) : (
        v.versions.map((ver) => {
          const m = v.metrics.by_version.find((x) => x.version_id === ver.id);
          const eAtiva = ver.id === v.campaign.active_version_id;
          return (
            <Secao
              key={ver.id}
              titulo={`V${ver.version_no}`}
              descricao={[
                ver.created_by_name ? pf(t("por {nome}"), { nome: ver.created_by_name }) : null,
                pf(t("criada em {quando}"), { quando: dataHora(ver.created_at) }),
                ver.superseded_at ? pf(t("substituída em {quando}"), { quando: dataHora(ver.superseded_at) }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              acao={eAtiva ? <Badge variant="success">{t("ativa")}</Badge> : ver.activated_at ? <Badge variant="neutral">{t("anterior")}</Badge> : <Badge variant="info">{t("guardada")}</Badge>}
            >
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-surface-elevated p-3 text-sm">{ver.body}</p>
              {m ? (
                <p className="mt-2 text-xs text-text-muted">
                  {pf(t("{enviados} enviados · {cliques} cliques ({ctr}) · {respostas} respostas · {falhas} falhas"), {
                    enviados: numero(m.sent),
                    cliques: numero(m.clicked),
                    ctr: percentual(m.clicked, m.sent),
                    respostas: numero(m.replied),
                    falhas: numero(m.failed),
                  })}
                </p>
              ) : null}
            </Secao>
          );
        })
      )}

      {editando ? <DialogoDeMensagem v={v} aoFechar={() => setEditando(false)} /> : null}
    </div>
  );
}

function DialogoDeMensagem({ v, aoFechar }: { v: VisaoGeral; aoFechar: () => void }) {
  const { t } = useTexto();
  const qc = useQueryClient();
  const criar = useCriarVersao(v.campaign.id);
  const e = useEditorDeMensagem(v);
  const [perguntando, setPerguntando] = React.useState(false);
  // Antes do primeiro envio ninguém recebeu nada: não há o que perguntar.
  const jaEnviou = v.counts.sent + v.counts.processing > 0 || v.campaign.status === "running" || v.campaign.status === "paused";

  const salvar = (activate: boolean) =>
    criar.mutate(
      { body: e.texto.trim(), activate, based_on_version_no: e.ativa?.version_no ?? 0 },
      {
        onSuccess: (r) => {
          avisarOk(pf(t(activate ? "Versão V{n} aplicada aos próximos contatos." : "Versão V{n} guardada, sem aplicar."), { n: r.version_no }));
          aoFechar();
        },
        onError: (erro) => {
          avisarErro(erro);
          // Outra pessoa alterou enquanto esta editava: recarrega para mostrar a versão atual.
          if (erro instanceof ErroDaCentral && erro.code === "version_conflict") void qc.invalidateQueries({ queryKey: chaves.campanha(v.campaign.id) });
          setPerguntando(false);
        },
      },
    );

  return (
    <Dialog open onOpenChange={(a) => (!a && !criar.isPending ? aoFechar() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{e.ativa ? pf(t("Editar mensagem (nova versão V{n})"), { n: (v.versions[0]?.version_no ?? 0) + 1 }) : t("Escrever mensagem")}</DialogTitle>
          <DialogDescription>{t("Personalize com as variáveis abaixo. O link do grupo nunca fica fixo no texto: trocar o grupo não exige editar a mensagem.")}</DialogDescription>
        </DialogHeader>

        <CampoDaMensagem e={e} />

        <DialogFooter>
          <Button variant="outline" onClick={aoFechar} disabled={criar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button disabled={criar.isPending || e.problema !== null || !e.mudou} onClick={() => (jaEnviou ? setPerguntando(true) : salvar(true))}>
            {criar.isPending ? <Girando className="size-4" /> : null}
            {t("Salvar")}
          </Button>
        </DialogFooter>

        <ConfirmarAcao
          aberto={perguntando}
          aoFechar={() => setPerguntando(false)}
          titulo="Aplicar esta nova versão aos próximos contatos da fila?"
          texto={
            <div className="space-y-3">
              <p>{t("Quem já recebeu continua com a versão anterior. Só os contatos que ainda não receberam passam a receber a nova.")}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={criar.isPending} onClick={() => salvar(false)}>
                  {t("Só guardar, sem aplicar")}
                </Button>
              </div>
            </div>
          }
          rotuloDoBotao="Aplicar aos próximos"
          ocupado={criar.isPending}
          aoConfirmar={() => salvar(true)}
        />
      </DialogContent>
    </Dialog>
  );
}
