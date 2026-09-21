"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { ocupacaoDoDestino } from "@/lib/campaigns/alertas";
import { funil, MOTIVO_DO_VETO, numero, percentual, ROTULO_DO_CANAL } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";

import { DialogoDeNumeros, DialogoDeRitmo } from "./DialogosDaCampanha";
import { Barra, CartaoDeMetrica, Secao, SeloDaCampanha, useTexto, useDatas, pf } from "./pecas";
import { CheckCircle, PaperPlaneTilt, ClockCountdown, WarningOctagon } from "@/lib/ui/icons";

export function AbaVisaoGeral({ v, pode }: { v: VisaoGeral; pode: PermissoesDaCentral }) {
  const { hora, quanto } = useDatas();
  const { t } = useTexto();
  const c = v.counts;
  const aberta = v.campaign.status !== "completed" && v.campaign.status !== "cancelled";
  const medido = v.destinations.some((d) => d.group_chat_id !== null);
  const { etapas, taxas } = funil({ total: c.total, sent: c.sent, clicked: c.clicked, joined: c.joined, left: c.left }, medido);
  const processados = c.sent + c.failed + c.uncertain + c.skipped + c.cancelled;
  const pendentes = c.pending + c.queued + c.processing;
  const [editandoNumeros, setEditandoNumeros] = React.useState(false);
  const [editandoRitmo, setEditandoRitmo] = React.useState(false);
  const ativa = v.campaign.active_version_id;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <CartaoDeMetrica rotulo="Contatos" valor={numero(c.total)} icone={CheckCircle} />
        <CartaoDeMetrica rotulo="Enviados" valor={numero(c.sent)} dica={percentual(c.sent, c.total)} icone={PaperPlaneTilt} tom="sucesso" />
        <CartaoDeMetrica rotulo="Pendentes" valor={numero(pendentes)} icone={ClockCountdown} tom="info" />
        <CartaoDeMetrica rotulo="Falhas" valor={numero(c.failed + c.uncertain)} dica={c.uncertain > 0 ? `${numero(c.uncertain)} incerta${c.uncertain > 1 ? "s" : ""}` : undefined} icone={WarningOctagon} tom={c.failed + c.uncertain > 0 ? "erro" : "neutro"} />
      </div>
      <Barra valor={processados} total={c.total} />

      <Secao titulo="Agora" descricao="O que está acontecendo neste instante." acao={<SeloDaCampanha status={v.campaign.status} />}>
        <BlocoAgora v={v} />
      </Secao>

      <Secao titulo="Funil" descricao="Do contato importado até quem continua no grupo.">
        <ul className="space-y-2">
          {etapas.map((e) => (
            <li key={e.chave} className="grid grid-cols-[7rem_1fr_6rem] items-center gap-3 text-sm">
              <span className="text-text-muted">{t(e.rotulo)}</span>
              {e.valor === null ? <span className="text-xs text-text-muted">{e.nota ? t(e.nota) : null}</span> : <Barra valor={e.valor} total={c.total} />}
              <span className="text-right font-semibold tabular-nums">{e.valor === null ? "—" : numero(e.valor)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-border pt-3 text-sm md:grid-cols-3">
          {taxas.map((x) => (
            <div key={x.rotulo} className="flex items-baseline justify-between gap-2">
              <dt className="text-text-muted">{t(x.rotulo)}</dt>
              <dd className="font-medium tabular-nums">{t(x.valor)}</dd>
            </div>
          ))}
        </dl>
        {!medido ? (
          <p className="mt-3 text-xs text-text-muted">
            {t("Entradas e saídas do grupo só são contadas quando o grupo de destino é monitorado (informe o ID do grupo em Destinos). Um clique não prova que a pessoa entrou.")}
          </p>
        ) : null}
      </Secao>

      <div className="grid gap-5 lg:grid-cols-2">
        <Secao titulo="Por versão da mensagem" descricao="Números de cada texto enviado — sem ranking.">
          <Tabela
            cabecalho={["Versão", "Enviados", "Cliques", "Respostas", "Falhas"]}
            linhas={v.metrics.by_version.map((m) => [
              <span key="v" className="flex items-center gap-2">
                V{m.version_no}
                {m.version_id === ativa ? <Badge variant="success">{t("ativa")}</Badge> : null}
              </span>,
              numero(m.sent),
              `${numero(m.clicked)} · ${percentual(m.clicked, m.sent)}`,
              numero(m.replied),
              numero(m.failed),
            ])}
            vazio="Nenhuma versão enviada ainda."
          />
        </Secao>

        <Secao titulo="Por grupo de destino" descricao="Para onde cada grupo foi direcionando as pessoas.">
          <Tabela
            cabecalho={["Grupo", "Recebeu", "Cliques", "Entradas", "Ocupação"]}
            linhas={v.metrics.by_destination.map((d) => {
              const med = v.destinations.find((x) => x.id === d.destination_id)?.group_chat_id != null;
              const oc = ocupacaoDoDestino({ name: d.name, status: d.status, capacity: d.capacity, directed: d.directed, joined: d.joined, left: d.left, measured: med });
              return [
                <span key="g" className="flex items-center gap-2">
                  {d.name}
                  {d.status === "active" ? <Badge variant="success">{t("ativo")}</Badge> : d.status === "closed" ? <Badge variant="neutral">{t("encerrado")}</Badge> : <Badge variant="info">{t("na fila")}</Badge>}
                </span>,
                numero(d.directed),
                numero(d.clicked),
                med ? pf(t("{joined} / {left} saíram"), { joined: numero(d.joined), left: numero(d.left) }) : t("não medido"),
                d.capacity ? `${pf(t("{usado} de {capacidade}"), { usado: numero(oc.usado), capacidade: numero(d.capacity) })}${oc.base === "directed" ? ` ${t("(estim.)")}` : ""}` : `${numero(oc.usado)}`,
              ];
            })}
            vazio="Nenhum grupo cadastrado."
          />
        </Secao>
      </div>

      <Secao
        id="numeros"
        titulo="Números"
        descricao="Cada número envia uma mensagem por vez, no intervalo definido."
        acao={
          aberta && pode.editar ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditandoRitmo(true)}>
                {t("Ritmo")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditandoNumeros(true)}>
                {t("Editar números")}
              </Button>
            </div>
          ) : null
        }
      >
        <p className="mb-3 text-xs text-text-muted">
          {pf(t("Intervalo: {n}s entre envios de cada número · limite diário da campanha: {limite}"), {
            n: v.campaign.send_interval_seconds,
            limite: v.campaign.daily_cap_per_channel === null ? t("o do próprio número") : pf(t("{n} por número"), { n: numero(v.campaign.daily_cap_per_channel) }),
          })}
        </p>
        <Tabela
          cabecalho={["Número", "Estado", "Enviados", "Falhas", "Último envio", "Situação"]}
          linhas={v.now.channels.map((n) => [
            n.label,
            <Badge key="e" variant={ROTULO_DO_CANAL[n.status]?.variante ?? "neutral"}>
              {t(ROTULO_DO_CANAL[n.status]?.label ?? n.status)}
            </Badge>,
            numero(n.sent),
            numero(n.failed),
            quanto(n.last_sent_at),
            n.can_send_now ? t("Pode enviar") : n.blocked_by ? `${pf(t("Aguardando: {motivo}"), { motivo: t(MOTIVO_DO_VETO[n.blocked_by]) })}${n.next_at ? ` ${pf(t("(até {hora})"), { hora: hora(n.next_at) })}` : ""}` : "—",
          ])}
          vazio="Nenhum número escolhido para esta campanha."
        />
      </Secao>

      <DialogoDeNumeros v={v} aberto={editandoNumeros} aoFechar={() => setEditandoNumeros(false)} />
      <DialogoDeRitmo v={v} aberto={editandoRitmo} aoFechar={() => setEditandoRitmo(false)} />
    </div>
  );
}

function BlocoAgora({ v }: { v: VisaoGeral }) {
  const { t } = useTexto();
  const { hora, quanto } = useDatas();
  const a = v.now;
  const rodando = v.campaign.status === "running";
  const ultimo = a.last_sent;
  const linhas: Array<[string, React.ReactNode]> = [
    [
      "Último envio",
      ultimo
        ? [`${ultimo.contact ?? ultimo.phone} · ${ultimo.phone}`, ultimo.channel ? pf(t("por {canal}"), { canal: ultimo.channel }) : null, quanto(ultimo.at)].filter(Boolean).join(" · ")
        : t("Nenhum envio ainda"),
    ],
    [
      "Enviando agora",
      a.in_flight ? [a.in_flight.contact ?? t("contato"), a.in_flight.channel ? pf(t("por {canal}"), { canal: a.in_flight.channel }) : null].filter(Boolean).join(" · ") : t("Nenhum"),
    ],
    ["Restam na fila", pf(t("{n} contatos"), { n: numero(a.remaining) })],
    ["Grupo atual", a.current_destination ?? "—"],
    ["Próximo envio", !rodando ? t("Campanha não está enviando") : a.next_at ? pf(t("às {hora}"), { hora: hora(a.next_at) }) : t("Agora")],
  ];
  return (
    <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
      {linhas.map(([k, val]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0">
          <dt className="shrink-0 text-text-muted">{t(k)}</dt>
          <dd className="min-w-0 truncate text-right font-medium">{val}</dd>
        </div>
      ))}
    </dl>
  );
}

function Tabela({ cabecalho, linhas, vazio }: { cabecalho: string[]; linhas: React.ReactNode[][]; vazio: string }) {
  const { t } = useTexto();
  if (linhas.length === 0) return <p className="text-sm text-text-muted">{t(vazio)}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-muted">
            {cabecalho.map((h, i) => (
              <th key={h} className={i === 0 ? "py-1.5 pr-3 font-medium" : "px-3 py-1.5 font-medium"}>
                {t(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {l.map((cel, j) => (
                <td key={j} className={j === 0 ? "py-2 pr-3 font-medium" : "px-3 py-2 tabular-nums"}>
                  {cel}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
