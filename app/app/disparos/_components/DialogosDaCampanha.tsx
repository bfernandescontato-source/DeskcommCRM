"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAtualizarCampanha, useDefinirCanais, type VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { ROTULO_DO_CANAL } from "@/lib/campaigns/formato";

import { avisarErro, avisarOk, Girando, useTexto } from "./pecas";

/** Quais números enviam esta campanha. Só números de WhatsApp da organização; o servidor confere. */
export function DialogoDeNumeros({ v, aberto, aoFechar }: { v: VisaoGeral; aberto: boolean; aoFechar: () => void }) {
  const { t } = useTexto();
  const sessoes = useChannelSessions({ enabled: aberto });
  const salvar = useDefinirCanais(v.campaign.id);
  const atuais = React.useMemo(() => v.channels.filter((c) => c.enabled).map((c) => c.channel_session_id), [v.channels]);
  const [marcados, setMarcados] = React.useState<string[]>(atuais);
  React.useEffect(() => {
    if (aberto) setMarcados(atuais);
  }, [aberto, atuais]);

  const alterna = (id: string) => setMarcados((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  return (
    <Dialog open={aberto} onOpenChange={(a) => (!a && !salvar.isPending ? aoFechar() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Números da campanha")}</DialogTitle>
          <DialogDescription>{t("Escolha por quais números as mensagens saem. Cada número envia uma por vez, respeitando o intervalo e o limite diário.")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {sessoes.isLoading ? <p className="text-sm text-text-muted">{t("Carregando números…")}</p> : null}
          {sessoes.isError ? <p className="text-sm text-error-fg">{t("Não foi possível listar os números.")}</p> : null}
          {(sessoes.data ?? []).length === 0 && !sessoes.isLoading && !sessoes.isError ? (
            <p className="text-sm text-text-muted">{t("Nenhum número conectado. Conecte um em Conexões.")}</p>
          ) : null}
          {(sessoes.data ?? []).map((s) => {
            const estado = t(ROTULO_DO_CANAL[s.status]?.label ?? s.status);
            return (
              <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 hover:bg-accent-soft/40">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={marcados.includes(s.id)} onChange={() => alterna(s.id)} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{channelLabel(s)}</span>
                <span className="text-xs text-text-muted">{estado}</span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar} disabled={salvar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button
            disabled={salvar.isPending}
            onClick={() =>
              salvar.mutate(marcados, {
                onSuccess: () => {
                  avisarOk(t("Números atualizados."));
                  aoFechar();
                },
                onError: avisarErro,
              })
            }
          >
            {salvar.isPending ? <Girando className="size-4" /> : null}
            {t("Salvar números")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Intervalo fixo entre envios de um número e teto diário da campanha. Sem aleatoriedade: o ritmo é o que está escrito. */
export function DialogoDeRitmo({ v, aberto, aoFechar }: { v: VisaoGeral; aberto: boolean; aoFechar: () => void }) {
  const { t } = useTexto();
  const salvar = useAtualizarCampanha(v.campaign.id);
  const [intervalo, setIntervalo] = React.useState(String(v.campaign.send_interval_seconds));
  const [teto, setTeto] = React.useState(v.campaign.daily_cap_per_channel === null ? "" : String(v.campaign.daily_cap_per_channel));
  React.useEffect(() => {
    if (aberto) {
      setIntervalo(String(v.campaign.send_interval_seconds));
      setTeto(v.campaign.daily_cap_per_channel === null ? "" : String(v.campaign.daily_cap_per_channel));
    }
  }, [aberto, v.campaign.send_interval_seconds, v.campaign.daily_cap_per_channel]);

  const n = Number(intervalo);
  const tetoNum = teto.trim() === "" ? null : Number(teto);
  const intervaloOk = Number.isInteger(n) && n >= 10 && n <= 3600;
  const tetoOk = tetoNum === null || (Number.isInteger(tetoNum) && tetoNum >= 1 && tetoNum <= 5000);

  return (
    <Dialog open={aberto} onOpenChange={(a) => (!a && !salvar.isPending ? aoFechar() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Ritmo de envio")}</DialogTitle>
          <DialogDescription>{t("Cada número envia uma mensagem por vez, sempre com o mesmo intervalo entre uma e outra. Vale já para os próximos envios.")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="intervalo">{t("Intervalo entre envios de cada número (segundos)")}</Label>
            <Input id="intervalo" inputMode="numeric" value={intervalo} onChange={(e) => setIntervalo(e.target.value)} aria-invalid={!intervaloOk} />
            <p className="text-xs text-text-muted">{t("Entre 10 e 3600. Com 180, cada número envia 20 mensagens por hora.")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="teto">{t("Limite diário desta campanha por número (opcional)")}</Label>
            <Input id="teto" inputMode="numeric" placeholder={t("Em branco = só vale o limite do próprio número")} value={teto} onChange={(e) => setTeto(e.target.value)} aria-invalid={!tetoOk} />
            <p className="text-xs text-text-muted">{t("Nunca passa do limite diário do próprio número, que continua valendo.")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar} disabled={salvar.isPending}>
            {t("Cancelar")}
          </Button>
          <Button
            disabled={salvar.isPending || !intervaloOk || !tetoOk}
            onClick={() =>
              salvar.mutate(
                { send_interval_seconds: n, daily_cap_per_channel: tetoNum },
                {
                  onSuccess: () => {
                    avisarOk(t("Ritmo atualizado."));
                    aoFechar();
                  },
                  onError: avisarErro,
                },
              )
            }
          >
            {salvar.isPending ? <Girando className="size-4" /> : null}
            {t("Salvar ritmo")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
