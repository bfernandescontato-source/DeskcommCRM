"use client";

import Link from "next/link";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAtivarDestino, useAtualizarCampanha, useCriarVersao, useDefinirCanais, useTransicao, type VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { duracaoEmPalavras, estimativaDeEnvio, numero, revisaoDaCampanha, ROTULO_DO_CANAL, usaLinkDoGrupo } from "@/lib/campaigns/formato";
import type { PermissoesDaCentral } from "@/lib/campaigns/permissoes";
import { CheckCircle, WarningOctagon } from "@/lib/ui/icons";

import { DialogoDeGrupo } from "./AbaDestinos";
import { CampoDaMensagem, useEditorDeMensagem } from "./EditorDeMensagem";
import { avisarErro, avisarOk, Girando, Secao, Selecao, useTexto, pf } from "./pecas";

// ── passo 2: mensagem ───────────────────────────────────────────────────────

export function PassoMensagem({ v, aoSalvar }: { v: VisaoGeral; aoSalvar: () => void }) {
  const { t } = useTexto();
  const e = useEditorDeMensagem(v);
  const criar = useCriarVersao(v.campaign.id);
  return (
    <Secao titulo="Escreva a mensagem" descricao="É o que cada pessoa vai receber. Use as variáveis para personalizar; o link do grupo entra por {{link_grupo}}.">
      <div className="flex flex-col gap-4">
        <CampoDaMensagem e={e} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={criar.isPending || e.problema !== null || !e.mudou}
            onClick={() =>
              criar.mutate(
                { body: e.texto.trim(), activate: true, based_on_version_no: e.ativa?.version_no ?? 0 },
                {
                  onSuccess: () => {
                    avisarOk(t("Mensagem salva."));
                    aoSalvar();
                  },
                  onError: avisarErro,
                },
              )
            }
          >
            {criar.isPending ? <Girando className="size-4" /> : null}
            {e.ativa ? t("Salvar alteração") : t("Salvar mensagem")}
          </Button>
          {e.ativa && !e.mudou ? <span className="text-xs text-success-fg">{pf(t("Mensagem salva (V{n})."), { n: e.ativa.version_no })}</span> : null}
        </div>
      </div>
    </Secao>
  );
}

// ── passo 3: destino ────────────────────────────────────────────────────────

export function PassoDestino({ v }: { v: VisaoGeral }) {
  const { t } = useTexto();
  const [adicionando, setAdicionando] = React.useState(false);
  const ativar = useAtivarDestino(v.campaign.id);
  const atualizar = useAtualizarCampanha(v.campaign.id);
  const ativo = v.destinations.find((d) => d.id === v.campaign.active_destination_id) ?? null;
  const corpo = v.versions.find((x) => x.id === v.campaign.active_version_id)?.body ?? null;
  const usaLink = usaLinkDoGrupo(corpo);

  return (
    <div className="flex flex-col gap-4">
      <Secao titulo="Para onde as pessoas vão" descricao={usaLink ? "A mensagem usa {{link_grupo}}: escolha o grupo que recebe as pessoas agora." : "A mensagem não usa {{link_grupo}}, então este passo é opcional."}>
        <div className="flex flex-col gap-3">
          {v.destinations.length === 0 ? <p className="text-sm text-text-muted">{t("Nenhum grupo cadastrado.")}</p> : null}
          {v.destinations.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{d.name}</p>
                <p className="truncate text-xs text-text-muted">{d.invite_url.replace(/^https:\/\//, "")}{d.capacity ? ` · capacidade ${numero(d.capacity)}` : ""}</p>
              </div>
              {d.id === ativo?.id ? (
                <Badge variant="success">{t("ativo")}</Badge>
              ) : d.status === "queued" ? (
                <Button size="sm" variant="outline" disabled={ativar.isPending} onClick={() => ativar.mutate({ destinationId: d.id, expected_current: ativo?.id ?? null }, { onError: avisarErro })}>
                  {t("Usar este")}
                </Button>
              ) : (
                <Badge variant="neutral">{t("encerrado")}</Badge>
              )}
            </div>
          ))}
          <Button className="w-fit" variant="outline" onClick={() => setAdicionando(true)}>
            {t("Adicionar grupo")}
          </Button>
        </div>
      </Secao>

      <Secao titulo="Link rastreado" descricao="Com o rastreio ligado, o link enviado passa por este sistema e conta os cliques. Sem ele, vai o link do grupo direto e não há contagem de cliques.">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={v.campaign.tracking_enabled}
            disabled={atualizar.isPending}
            onChange={(ev) => atualizar.mutate({ tracking_enabled: ev.target.checked }, { onError: avisarErro })}
          />
          {t("Contar cliques no link do grupo")}
        </label>
      </Secao>

      {adicionando ? <DialogoDeGrupo v={v} ativo={ativo?.id ?? null} aoFechar={() => setAdicionando(false)} /> : null}
    </div>
  );
}

// ── passo 4: envio ──────────────────────────────────────────────────────────

const POLITICA = [
  { valor: "skip_channel", rotulo: "Seguir com os outros números" },
  { valor: "pause_campaign", rotulo: "Pausar a campanha inteira" },
];

export function PassoEnvio({ v }: { v: VisaoGeral }) {
  const { t } = useTexto();
  const sessoes = useChannelSessions();
  const definir = useDefinirCanais(v.campaign.id);
  const atualizar = useAtualizarCampanha(v.campaign.id);
  const escolhidos = v.channels.filter((c) => c.enabled).map((c) => c.channel_session_id);
  const [intervalo, setIntervalo] = React.useState(String(v.campaign.send_interval_seconds));
  const [teto, setTeto] = React.useState(v.campaign.daily_cap_per_channel === null ? "" : String(v.campaign.daily_cap_per_channel));

  const n = Number(intervalo);
  const tetoNum = teto.trim() === "" ? null : Number(teto);
  const intervaloOk = Number.isInteger(n) && n >= 10 && n <= 3600;
  const tetoOk = tetoNum === null || (Number.isInteger(tetoNum) && tetoNum >= 1 && tetoNum <= 5000);
  const mudouRitmo = n !== v.campaign.send_interval_seconds || tetoNum !== v.campaign.daily_cap_per_channel;

  const limites = (sessoes.data ?? []).filter((s) => escolhidos.includes(s.id)).map((s) => s.daily_message_limit);
  const estimativa = estimativaDeEnvio({ pendentes: v.counts.pending, limitesDiarios: limites, intervaloSegundos: intervaloOk ? n : v.campaign.send_interval_seconds, tetoDaCampanha: tetoOk ? tetoNum : null });

  const alterna = (id: string) => definir.mutate(escolhidos.includes(id) ? escolhidos.filter((x) => x !== id) : [...escolhidos, id], { onError: avisarErro });

  return (
    <div className="flex flex-col gap-4">
      <Secao titulo="Por quais números enviar" descricao="Cada número envia uma mensagem por vez. Mais números, mais rápido.">
        <div className="space-y-1.5">
          {sessoes.isLoading ? <p className="text-sm text-text-muted">{t("Carregando números…")}</p> : null}
          {(sessoes.data ?? []).length === 0 && !sessoes.isLoading ? (
            <p className="text-sm text-text-muted">
              {t("Nenhum número conectado.")} <Link href="/app/connections" className="text-accent underline">{t("Conecte um em Conexões")}</Link>.
            </p>
          ) : null}
          {(sessoes.data ?? []).map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 hover:bg-accent-soft/40">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={escolhidos.includes(s.id)} disabled={definir.isPending} onChange={() => alterna(s.id)} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{channelLabel(s)}</span>
              <span className="text-xs text-text-muted">{pf(t("até {n}/dia"), { n: numero(s.daily_message_limit) })}</span>
              <Badge variant={ROTULO_DO_CANAL[s.status]?.variante ?? "neutral"}>{t(ROTULO_DO_CANAL[s.status]?.label ?? s.status)}</Badge>
            </label>
          ))}
        </div>
      </Secao>

      <Secao titulo="Ritmo" descricao="O intervalo é fixo e igual para todos os envios de um número. O sistema não varia o ritmo.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ritmo-intervalo">{t("Intervalo entre envios de cada número (segundos)")}</Label>
            <Input id="ritmo-intervalo" inputMode="numeric" value={intervalo} onChange={(e) => setIntervalo(e.target.value)} aria-invalid={!intervaloOk} />
            <p className="text-xs text-text-muted">{pf(t("Entre 10 e 3600. Com {n}s, cada número envia até {porHora} por hora."), { n: intervaloOk ? n : "…", porHora: intervaloOk ? numero(Math.floor(3600 / n)) : "…" })}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ritmo-teto">{t("Limite diário desta campanha por número (opcional)")}</Label>
            <Input id="ritmo-teto" inputMode="numeric" value={teto} onChange={(e) => setTeto(e.target.value)} placeholder={t("Em branco = o limite do próprio número")} aria-invalid={!tetoOk} />
            <p className="text-xs text-text-muted">{t("Nunca passa do limite diário do próprio número.")}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("Se um número cair")}</Label>
            <Selecao rotulo="Política de número caído" className="w-full" valor={v.campaign.channel_policy} aoMudar={(x) => atualizar.mutate({ channel_policy: x as "skip_channel" | "pause_campaign" }, { onError: avisarErro })} opcoes={POLITICA} />
          </div>
        </div>
        <Button
          className="mt-4"
          variant="outline"
          disabled={atualizar.isPending || !intervaloOk || !tetoOk || !mudouRitmo}
          onClick={() => atualizar.mutate({ send_interval_seconds: n, daily_cap_per_channel: tetoNum }, { onSuccess: () => avisarOk(t("Ritmo salvo.")), onError: avisarErro })}
        >
          {atualizar.isPending ? <Girando className="size-4" /> : null}
          {t("Salvar ritmo")}
        </Button>
      </Secao>

      <Secao titulo="Quanto vai levar">
        <p className="text-sm">
          {estimativa.dias === null ? (
            t("Escolha ao menos um número para ver a estimativa.")
          ) : (
            pf(t("Com {contatos} contatos e até {porDia} mensagens por dia, a fila leva {duracao}."), {
              contatos: numero(v.counts.pending),
              porDia: numero(estimativa.porDia),
              duracao: duracaoEmPalavras(estimativa.dias, t),
            })
          )}
        </p>
        <p className="mt-1 text-xs text-text-muted">{t("É o máximo possível: números em aquecimento, quedas e o horário de envio podem deixar mais lento. Mais números aceleram na mesma proporção.")}</p>
      </Secao>
    </div>
  );
}

// ── passo 5: revisão e início ───────────────────────────────────────────────

export function PassoRevisao({ v, pode, aoIniciar }: { v: VisaoGeral; pode: PermissoesDaCentral; aoIniciar: () => void }) {
  const { t } = useTexto();
  const transicao = useTransicao(v.campaign.id);
  const corpo = v.versions.find((x) => x.id === v.campaign.active_version_id)?.body ?? null;
  const itens = revisaoDaCampanha({ pendentes: v.counts.pending, corpoAtivo: corpo, temDestinoAtivo: v.campaign.active_destination_id !== null, numerosEscolhidos: v.channels.filter((c) => c.enabled).length }, t);
  const pronto = itens.every((i) => i.ok);

  return (
    <Secao titulo="Revisão" descricao={pronto ? "Tudo certo. Ao iniciar, as mensagens começam a sair. Você pode pausar quando quiser e a fila continua do mesmo ponto." : "Falta resolver o que está em vermelho antes de iniciar."}>
      <ul className="flex flex-col gap-2">
        {itens.map((i) => (
          <li key={i.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
            {i.ok ? <CheckCircle weight="duotone" className="size-5 text-success-fg" aria-hidden /> : <WarningOctagon weight="duotone" className="size-5 text-error-fg" aria-hidden />}
            <span className="font-medium">{i.titulo}</span>
            <span className="text-text-muted">{i.detalhe}</span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {pode.iniciar ? (
          <Button
            disabled={!pronto || transicao.isPending}
            onClick={() => transicao.mutate({ action: "start" }, { onSuccess: () => aoIniciar(), onError: avisarErro })}
          >
            {transicao.isPending ? <Girando className="size-4" /> : null}
            {t("Iniciar campanha")}
          </Button>
        ) : (
          <>
            <Button disabled={!pronto || transicao.isPending || v.campaign.status === "ready"} onClick={() => transicao.mutate({ action: "ready" }, { onSuccess: () => avisarOk(t("Campanha pronta. Um administrador precisa iniciá-la.")), onError: avisarErro })}>
              {v.campaign.status === "ready" ? t("Pronta para iniciar") : t("Deixar pronta para iniciar")}
            </Button>
            <span className="text-xs text-text-muted">{t("Só um administrador inicia o envio.")}</span>
          </>
        )}
        <Button asChild variant="ghost">
          <Link href={`/app/disparos/${v.campaign.id}`}>{t("Ver campanha")}</Link>
        </Button>
      </div>
    </Secao>
  );
}
