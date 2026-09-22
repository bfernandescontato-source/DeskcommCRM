"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAtivarDestino, useCadastrarDestino, type VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { ocupacaoDoDestino } from "@/lib/campaigns/alertas";
import { numero, percentual, medicaoDoDestino } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { conviteValido } from "@/lib/campaigns/schemas";
import { ArrowSquareOut, Plus } from "@/lib/ui/icons";

import { avisarErro, avisarOk, Barra, ConfirmarAcao, Girando, Secao, Selecao, Vazio, useTexto, useDatas, pf } from "./pecas";

const MOTIVO_DO_FECHAMENTO: Record<string, string> = { full: "lotado", manual: "encerrado à mão", campaign_ended: "campanha encerrada" };
const ESTADO_DO_GRUPO = {
  active: { label: "ativo", variante: "success" },
  queued: { label: "na fila", variante: "info" },
  closed: { label: "encerrado", variante: "neutral" },
} as const;

export function AbaDestinos({ v, pode }: { v: VisaoGeral; pode: PermissoesDaCentral }) {
  const { dataHora } = useDatas();
  const { t } = useTexto();
  const aberta = v.campaign.status !== "completed" && v.campaign.status !== "cancelled";
  const ativo = v.destinations.find((d) => d.id === v.campaign.active_destination_id) ?? null;
  const [adicionando, setAdicionando] = React.useState(false);
  const [trocandoPara, setTrocandoPara] = React.useState<string | null>(null);
  const ativar = useAtivarDestino(v.campaign.id);
  const [motivo, setMotivo] = React.useState<"full" | "manual">("full");
  const alvo = v.destinations.find((d) => d.id === trocandoPara) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-muted">
          {t("Um grupo recebe as pessoas por vez. Quando ele encher, o sistema avisa — a troca é sempre feita por você, nunca sozinha. O histórico de cada grupo fica guardado.")}
        </p>
        {pode.editar && aberta ? (
          <Button onClick={() => setAdicionando(true)}>
            <Plus weight="bold" /> {t("Adicionar grupo")}
          </Button>
        ) : null}
      </div>

      {v.destinations.length === 0 ? (
        <Vazio titulo="Nenhum grupo cadastrado" texto="Cadastre o link de convite do grupo do WhatsApp. É o que a mensagem envia em {{link_grupo}}." />
      ) : (
        <div className="grid gap-3">
          {v.destinations.map((d) => {
            const m = v.metrics.by_destination.find((x) => x.destination_id === d.id);
            const medicao = medicaoDoDestino({ group_chat_id: d.group_chat_id, joined_total: m?.joined_total, members_left: m?.members_left });
            const medido = medicao === "medido";
            const oc = ocupacaoDoDestino({ name: d.name, status: d.status, capacity: d.capacity, directed: m?.directed ?? 0, joined: m?.joined ?? 0, left: m?.left ?? 0, measured: medido, members: m?.members });
            const est = ESTADO_DO_GRUPO[d.status];
            return (
              <article key={d.id} className="rounded-xl border border-border bg-surface p-4">
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">{d.name}</h3>
                      <Badge variant={est.variante}>{t(est.label)}</Badge>
                    </div>
                    <a href={d.invite_url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-text-muted hover:text-accent">
                      {d.invite_url.replace(/^https:\/\//, "")} <ArrowSquareOut className="size-3" aria-hidden />
                    </a>
                  </div>
                  {d.status === "queued" && pode.editar && aberta ? (
                    <Button size="sm" variant={ativo ? "outline" : "primary"} onClick={() => setTrocandoPara(d.id)}>
                      {ativo ? t("Trocar para este grupo") : t("Usar este grupo")}
                    </Button>
                  ) : null}
                </header>

                {d.capacity ? (
                  <div className="mt-3">
                    <Barra valor={oc.usado} total={d.capacity} />
                    <p className="mt-1 text-xs text-text-muted">
                      {pf(t("{usado} de {capacidade} ({pct}) · {base}"), {
                        usado: numero(oc.usado),
                        capacidade: numero(d.capacity),
                        pct: percentual(oc.usado, d.capacity, 0),
                        base: oc.base === "members" ? t("membros medidos") : t("pessoas direcionadas (estimativa: o CRM não vê este grupo)"),
                      })}
                    </p>
                  </div>
                ) : null}

                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  <Fato k="Receberam o link" v={numero(m?.directed ?? 0)} />
                  <Fato k="Cliques" v={numero(m?.clicked ?? 0)} />
                  <Fato k="Entraram" v={medido ? numero(m?.joined_total ?? 0) : t(medicao === "aguardando" ? "aguardando o primeiro aviso" : "não medido")} />
                  <Fato k="Saíram" v={medido ? numero(m?.members_left ?? 0) : t(medicao === "aguardando" ? "aguardando o primeiro aviso" : "não medido")} />
                  {medido ? <Fato k="Identificados" v={numero(m?.joined ?? 0)} /> : null}
                </dl>
                {medicao === "aguardando" ? (
                  <p className="mt-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning-fg">
                    {t("Grupo monitorado, mas ainda não chegou nenhum aviso de entrada ou saída. Se alguém já entrou e isto não muda, confira se um dos números da campanha está no grupo.")}
                  </p>
                ) : null}

                <p className="mt-3 text-xs text-text-muted">
                  {d.opened_at ? pf(t("Ativo desde {quando}"), { quando: dataHora(d.opened_at) }) : t("Ainda não foi ativado")}
                  {d.closed_at ? ` · ${pf(t("encerrado em {quando}"), { quando: dataHora(d.closed_at) })}${d.close_reason ? ` (${t(MOTIVO_DO_FECHAMENTO[d.close_reason] ?? d.close_reason)})` : ""}` : ""}
                </p>
              </article>
            );
          })}
        </div>
      )}

      {adicionando ? <DialogoDeGrupo v={v} ativo={ativo?.id ?? null} aoFechar={() => setAdicionando(false)} /> : null}

      {alvo ? (
        <ConfirmarAcao
          aberto
          aoFechar={() => setTrocandoPara(null)}
          titulo={ativo ? `Trocar ${ativo.name} → ${alvo.name}?` : `Usar ${alvo.name}?`}
          texto={
            <div className="space-y-3">
              <p>{t("Os próximos envios usam o link do novo grupo. Quem já recebeu a mensagem continua com o link que recebeu; a troca fica registrada no histórico.")}</p>
              {ativo ? (
                <div className="space-y-1">
                  <Label htmlFor="motivo">{t("Por que o grupo anterior sai?")}</Label>
                  <Selecao rotulo="Motivo" className="w-full" valor={motivo} aoMudar={(x) => setMotivo(x as "full" | "manual")} opcoes={[{ valor: "full", rotulo: "Lotou" }, { valor: "manual", rotulo: "Encerrei por decisão minha" }]} />
                </div>
              ) : null}
            </div>
          }
          rotuloDoBotao="Confirmar troca"
          ocupado={ativar.isPending}
          aoConfirmar={() =>
            ativar.mutate(
              { destinationId: alvo.id, expected_current: ativo?.id ?? null, close_reason: motivo },
              {
                onSuccess: () => {
                  avisarOk(t("Grupo atualizado."));
                  setTrocandoPara(null);
                },
                onError: (e) => {
                  avisarErro(e);
                  setTrocandoPara(null);
                },
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

function Fato({ k, v }: { k: string; v: string }) {
  const { t } = useTexto();
  return (
    <div>
      <dt className="text-xs text-text-muted">{t(k)}</dt>
      <dd className="font-semibold tabular-nums">{v}</dd>
    </div>
  );
}

export function DialogoDeGrupo({ v, ativo, aoFechar }: { v: VisaoGeral; ativo: string | null; aoFechar: () => void }) {
  const { t } = useTexto();
  const cadastrar = useCadastrarDestino(v.campaign.id);
  const [nome, setNome] = React.useState("");
  const [link, setLink] = React.useState("");
  const [capacidade, setCapacidade] = React.useState("");
  const [idDoGrupo, setIdDoGrupo] = React.useState("");
  const [ativarAgora, setAtivarAgora] = React.useState(ativo === null);
  const [motivo, setMotivo] = React.useState<"full" | "manual">("full");

  const cap = capacidade.trim() === "" ? null : Number(capacidade);
  const erroDoNome = nome.trim() === "" ? "Dê um nome ao grupo." : null;
  const erroDoLink = !conviteValido(link.trim()) ? "Use o link de convite do WhatsApp (https://chat.whatsapp.com/…)." : null;
  const erroDaCapacidade = cap !== null && !(Number.isInteger(cap) && cap >= 1 && cap <= 100_000) ? "Informe um número inteiro." : null;
  const erroDoId = idDoGrupo.trim() !== "" && !/^[0-9-]+@g\.us$/.test(idDoGrupo.trim()) ? "Formato esperado: 1203…@g.us" : null;
  const invalido = erroDoNome || erroDoLink || erroDaCapacidade || erroDoId;

  return (
    <Dialog open onOpenChange={(a) => (!a && !cadastrar.isPending ? aoFechar() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Adicionar grupo de destino")}</DialogTitle>
          <DialogDescription>{t("O link de convite é o que as pessoas recebem. Você pode cadastrar vários grupos e escolher qual está ativo.")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="g-nome">{t("Nome do grupo")}</Label>
            <Input id="g-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t("BLACK #04")} maxLength={80} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="g-link">{t("Link de convite")}</Label>
            <Input id="g-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://chat.whatsapp.com/…" aria-invalid={link.trim() !== "" && erroDoLink !== null} />
            {link.trim() !== "" && erroDoLink ? <p className="text-xs text-error-fg">{t(erroDoLink)}</p> : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="g-cap">{t("Capacidade (opcional)")}</Label>
              <Input id="g-cap" inputMode="numeric" value={capacidade} onChange={(e) => setCapacidade(e.target.value)} placeholder="1024" aria-invalid={erroDaCapacidade !== null} />
              <p className="text-xs text-text-muted">{t("Avisamos quando chegar perto.")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="g-id">{t("ID do grupo (opcional)")}</Label>
              <Input id="g-id" value={idDoGrupo} onChange={(e) => setIdDoGrupo(e.target.value)} placeholder="1203…@g.us" aria-invalid={erroDoId !== null} />
              <p className="text-xs text-text-muted">{t(erroDoId ?? "Só com ele o CRM mede entradas e saídas.")}</p>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={ativarAgora} onChange={(e) => setAtivarAgora(e.target.checked)} />
            {ativo ? t("Usar este grupo agora (troca o atual)") : t("Usar este grupo agora")}
          </label>
          {ativarAgora && ativo ? (
            <Selecao rotulo="Motivo da troca" className="w-full" valor={motivo} aoMudar={(x) => setMotivo(x as "full" | "manual")} opcoes={[{ valor: "full", rotulo: "O grupo anterior lotou" }, { valor: "manual", rotulo: "Encerrei o anterior por decisão minha" }]} />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar} disabled={cadastrar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button
            disabled={cadastrar.isPending || invalido !== null}
            onClick={() =>
              cadastrar.mutate(
                {
                  name: nome.trim(),
                  invite_url: link.trim(),
                  capacity: cap,
                  group_chat_id: idDoGrupo.trim() === "" ? null : idDoGrupo.trim(),
                  activate: ativarAgora,
                  expected_current: ativarAgora ? ativo : null,
                  close_reason: motivo,
                },
                {
                  onSuccess: () => {
                    avisarOk(t("Grupo cadastrado."));
                    aoFechar();
                  },
                  onError: avisarErro,
                },
              )
            }
          >
            {cadastrar.isPending ? <Girando className="size-4" /> : null}
            {t("Adicionar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
