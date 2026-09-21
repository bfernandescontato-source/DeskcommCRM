"use client";

import Link from "next/link";
import * as React from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Alerta } from "@/lib/campaigns/alertas";
import { destinoDoAlerta, ROTULO_DA_CAMPANHA, ROTULO_DO_ALERTA, ROTULO_DO_ENVIO, ROTULO_DO_ESTADO_DO_CONTATO, type AcaoNaTela } from "@/lib/campaigns/formato";
import type { CampaignStatus } from "@/lib/campaigns/vocabulario";
import { CircleNotch, Info, Warning, WarningOctagon } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

// ── selos de estado ─────────────────────────────────────────────────────────

export function SeloDaCampanha({ status }: { status: CampaignStatus }) {
  const r = ROTULO_DA_CAMPANHA[status];
  return <Badge variant={r.variante}>{r.label}</Badge>;
}

export function SeloDoContato({ estado }: { estado: string }) {
  const r = ROTULO_DO_ESTADO_DO_CONTATO[estado] ?? { label: estado, variante: "neutral" as const };
  return <Badge variant={r.variante}>{r.label}</Badge>;
}

export function SeloDoEnvio({ status }: { status: string }) {
  const r = ROTULO_DO_ENVIO[status] ?? { label: status, variante: "neutral" as const };
  return <Badge variant={r.variante}>{r.label}</Badge>;
}

// ── números ─────────────────────────────────────────────────────────────────

const TOM: Record<"neutro" | "sucesso" | "aviso" | "erro" | "info", string> = {
  neutro: "bg-accent-soft text-accent",
  sucesso: "bg-success-bg text-success-fg",
  aviso: "bg-warning-bg text-warning-fg",
  erro: "bg-error-bg text-error-fg",
  info: "bg-info-bg text-info-fg",
};

export function CartaoDeMetrica({
  rotulo,
  valor,
  dica,
  icone: Icone,
  tom = "neutro",
  carregando,
}: {
  rotulo: string;
  valor: string;
  dica?: string;
  icone: PhosphorIcon;
  tom?: keyof typeof TOM;
  carregando?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-text-muted">{rotulo}</p>
        {carregando ? (
          <Skeleton className="mt-2 h-8 w-20" />
        ) : (
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{valor}</p>
        )}
        {dica && !carregando ? <p className="mt-0.5 truncate text-xs text-text-muted">{dica}</p> : null}
      </div>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", TOM[tom])}>
        <Icone weight="duotone" className="size-5" aria-hidden />
      </span>
    </div>
  );
}

/** Barra de progresso fina. `valor`/`total` em contagem; sem total, fica vazia (nunca NaN%). */
export function Barra({ valor, total, className }: { valor: number; total: number; className?: string }) {
  const pct = total > 0 ? Math.min(Math.max((valor / total) * 100, 0), 100) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(valor, total)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-border", className)}
    >
      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Secao({ titulo, descricao, acao, children, id }: { titulo: string; descricao?: string; acao?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-xl border border-border bg-surface">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{titulo}</h2>
          {descricao ? <p className="mt-0.5 text-xs text-text-muted">{descricao}</p> : null}
        </div>
        {acao}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Vazio({ titulo, texto, acao }: { titulo: string; texto?: string; acao?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium">{titulo}</p>
      {texto ? <p className="max-w-md text-xs text-text-muted">{texto}</p> : null}
      {acao}
    </div>
  );
}

export function ErroNaTela({ mensagem, onTentar }: { mensagem: string; onTentar?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-error-bg px-4 py-3 text-sm text-error-fg">
      <span>{mensagem}</span>
      {onTentar ? (
        <Button size="sm" variant="outline" onClick={onTentar}>
          Tentar de novo
        </Button>
      ) : null}
    </div>
  );
}

export function Girando({ className }: { className?: string }) {
  return <CircleNotch className={cn("animate-spin", className)} aria-hidden />;
}

// ── alertas ─────────────────────────────────────────────────────────────────

const ESTILO_DO_ALERTA: Record<Alerta["level"], { caixa: string; icone: PhosphorIcon }> = {
  critical: { caixa: "border-error-fg/30 bg-error-bg text-error-fg", icone: WarningOctagon },
  warning: { caixa: "border-warning-fg/30 bg-warning-bg text-warning-fg", icone: Warning },
  info: { caixa: "border-info-fg/30 bg-info-bg text-info-fg", icone: Info },
};

export function ListaDeAlertas({ campaignId, campanha, alertas }: { campaignId: string; campanha?: string; alertas: Alerta[] }) {
  if (alertas.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label="Alertas">
      {alertas.map((a) => {
        const est = ESTILO_DO_ALERTA[a.level];
        const Icone = est.icone;
        const href = destinoDoAlerta(campaignId, a);
        return (
          <li key={`${a.code}-${a.subject ?? ""}`} className={cn("flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm", est.caixa)}>
            <Icone weight="duotone" className="size-5 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">
              {campanha ? <span className="font-semibold">{campanha}: </span> : null}
              {a.message}
            </p>
            {href && ROTULO_DO_ALERTA[a.action] ? (
              <Button asChild size="sm" variant="outline" className="shrink-0 bg-surface text-text">
                <Link href={href}>{ROTULO_DO_ALERTA[a.action]}</Link>
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ── confirmação ─────────────────────────────────────────────────────────────

export function ConfirmarAcao({
  aberto,
  aoFechar,
  titulo,
  texto,
  rotuloDoBotao,
  perigo,
  ocupado,
  aoConfirmar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  titulo: string;
  texto: React.ReactNode;
  rotuloDoBotao: string;
  perigo?: boolean;
  ocupado?: boolean;
  aoConfirmar: () => void;
}) {
  return (
    <AlertDialog open={aberto} onOpenChange={(v) => (!v && !ocupado ? aoFechar() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{titulo}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-text-muted">{texto}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={ocupado}>Voltar</AlertDialogCancel>
          <Button variant={perigo ? "destructive" : "primary"} onClick={aoConfirmar} disabled={ocupado}>
            {ocupado ? <Girando className="size-4" /> : null}
            {rotuloDoBotao}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** O botão de uma ação de campanha (Iniciar, Pausar, Retomar, Encerrar…), com a confirmação quando ela exige. */
export function BotaoDeAcao({
  acao,
  ocupado,
  aoExecutar,
  compacto,
}: {
  acao: AcaoNaTela;
  ocupado: boolean;
  aoExecutar: (a: AcaoNaTela) => void;
  compacto?: boolean;
}) {
  const [pedindo, setPedindo] = React.useState(false);
  const variante = acao.tom === "primario" ? "primary" : acao.tom === "perigo" ? "outline" : "outline";
  return (
    <>
      <Button
        size={compacto ? "sm" : "default"}
        variant={variante}
        className={acao.tom === "perigo" ? "text-error-fg hover:border-error-fg hover:text-error-fg" : undefined}
        disabled={ocupado}
        onClick={() => (acao.confirmar ? setPedindo(true) : aoExecutar(acao))}
      >
        {ocupado && !acao.confirmar ? <Girando className="size-4" /> : null}
        {acao.rotulo}
      </Button>
      {acao.confirmar ? (
        <ConfirmarAcao
          aberto={pedindo}
          aoFechar={() => setPedindo(false)}
          titulo={`${acao.rotulo}?`}
          texto={acao.aviso}
          rotuloDoBotao={acao.rotulo}
          perigo={acao.tom === "perigo"}
          ocupado={ocupado}
          aoConfirmar={() => {
            aoExecutar(acao);
            setPedindo(false);
          }}
        />
      ) : null}
    </>
  );
}

/** Toast de erro com a frase que o servidor mandou (já em português e sem detalhe técnico). */
export function avisarErro(e: unknown) {
  toast.error(e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente de novo.");
}

export function avisarOk(mensagem: string) {
  toast.success(mensagem);
}
