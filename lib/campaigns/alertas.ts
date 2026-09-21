/**
 * OS ALERTAS DA CENTRAL — só o que exige a atenção de alguém.
 *
 * Função PURA sobre um retrato da campanha: a mesma entrada dá sempre a mesma lista, e é
 * por isso que ela é testável sem banco e sem tela. A interface mostra o que sai daqui e
 * nada além — alerta demais vira ruído e ensina a ignorar.
 *
 * Níveis: `critical` (nada está saindo ou vai parar), `warning` (precisa de uma decisão
 * logo), `info` (bom saber). Cada alerta traz a AÇÃO que resolve, para a tela oferecer o
 * botão certo em vez de só apontar o problema.
 */
import type { CampaignStatus } from "./vocabulario";

export type NivelDeAlerta = "info" | "warning" | "critical";

export type AcaoDoAlerta = "switch_destination" | "resume" | "edit_channels" | "review_uncertain" | "review_failures" | "view_import" | "none";

export interface Alerta {
  level: NivelDeAlerta;
  code: string;
  /** Texto pronto para a tela, em português. */
  message: string;
  action: AcaoDoAlerta;
  /** O que o alerta cita (destino, número) — a tela pode destacar. */
  subject?: string;
}

export interface RetratoDaCampanha {
  status: CampaignStatus;
  statusReason: string | null;
  counts: { pending: number; sent: number; failed: number; uncertain: number };
  channels: Array<{ label: string; status: string; enabled: boolean }>;
  destinations: Array<{
    name: string;
    status: string;
    capacity: number | null;
    directed: number;
    joined: number;
    left: number;
    /** O CRM enxerga o grupo (tem id do grupo)? Só então entradas e saídas são MEDIDAS. */
    measured: boolean;
  }>;
  lastImport: { rejected: number; found: number } | null;
}

/** Perto do limite: avisa aqui e oferece TROCAR DESTINO. Nunca troca sozinho. */
export const LIMIAR_DE_CAPACIDADE = 0.9;
/** Falha só vira alerta com amostra mínima: 1 falha em 3 envios não é taxa. */
export const AMOSTRA_MINIMA_DE_FALHA = 20;
export const LIMIAR_DE_FALHA_ALTA = 0.1;
export const LIMIAR_DE_FALHA_CRITICA = 0.3;

const ORDEM: Record<NivelDeAlerta, number> = { critical: 0, warning: 1, info: 2 };

/** Quantas pessoas o destino tem AGORA: entradas menos saídas se medido; senão, o que foi direcionado. */
export function ocupacaoDoDestino(d: RetratoDaCampanha["destinations"][number]): { usado: number; base: "members" | "directed" } {
  return d.measured ? { usado: Math.max(d.joined - d.left, 0), base: "members" } : { usado: d.directed, base: "directed" };
}

export function calcularAlertas(r: RetratoDaCampanha): Alerta[] {
  const alertas: Alerta[] = [];
  const ativa = r.status === "running" || r.status === "paused" || r.status === "error";

  if (r.status === "paused") {
    const porSistema: Record<string, Alerta> = {
      no_channel: { level: "critical", code: "campaign_paused", message: "Campanha pausada: nenhum número está conectado.", action: "edit_channels" },
      channel_down: { level: "warning", code: "campaign_paused", message: "Campanha pausada porque um número caiu.", action: "resume" },
      no_destination: { level: "warning", code: "campaign_paused", message: "Campanha pausada: a mensagem usa {{link_grupo}} e não há grupo de destino ativo.", action: "switch_destination" },
    };
    alertas.push(porSistema[r.statusReason ?? ""] ?? { level: "info", code: "campaign_paused", message: "Campanha pausada.", action: "resume" });
  }
  if (r.status === "error") {
    alertas.push({ level: "critical", code: "campaign_error", message: "A campanha parou por um erro.", action: "resume" });
  }

  if (ativa) {
    const habilitados = r.channels.filter((c) => c.enabled);
    const caidos = habilitados.filter((c) => c.status !== "WORKING");
    if (habilitados.length === 0 || caidos.length === habilitados.length) {
      // Já avisado como "pausada" quando o sistema pausou por isso; não repete a mesma coisa.
      if (!(r.status === "paused" && r.statusReason === "no_channel")) {
        alertas.push({ level: "critical", code: "no_channel", message: "Nenhum número disponível para enviar.", action: "edit_channels" });
      }
    } else {
      for (const c of caidos) {
        alertas.push({ level: "warning", code: "channel_down", message: `${c.label} está desconectado.`, action: "edit_channels", subject: c.label });
      }
    }
  }

  for (const d of r.destinations) {
    if (d.status !== "active" || d.capacity === null || d.capacity <= 0) continue;
    const { usado, base } = ocupacaoDoDestino(d);
    const fracao = usado / d.capacity;
    if (fracao >= 1) {
      alertas.push({ level: "critical", code: "capacity_full", message: `${d.name} atingiu a capacidade (${usado} / ${d.capacity}${base === "directed" ? ", direcionados" : ""}).`, action: "switch_destination", subject: d.name });
    } else if (fracao >= LIMIAR_DE_CAPACIDADE) {
      alertas.push({ level: "warning", code: "capacity_near", message: `Grupo próximo da capacidade: ${d.name} ${usado} / ${d.capacity}${base === "directed" ? " (direcionados)" : ""}.`, action: "switch_destination", subject: d.name });
    }
  }

  const tentativas = r.counts.sent + r.counts.failed + r.counts.uncertain;
  if (tentativas >= AMOSTRA_MINIMA_DE_FALHA) {
    const taxa = (r.counts.failed + r.counts.uncertain) / tentativas;
    if (taxa >= LIMIAR_DE_FALHA_CRITICA) {
      alertas.push({ level: "critical", code: "high_failure_rate", message: `Taxa de falha alta: ${Math.round(taxa * 100)}% dos envios.`, action: "review_failures" });
    } else if (taxa >= LIMIAR_DE_FALHA_ALTA) {
      alertas.push({ level: "warning", code: "high_failure_rate", message: `Taxa de falha elevada: ${Math.round(taxa * 100)}% dos envios.`, action: "review_failures" });
    }
  }

  if (r.counts.uncertain > 0) {
    alertas.push({
      level: "warning",
      code: "uncertain_sends",
      message: r.counts.uncertain === 1 ? "1 envio ficou incerto e precisa da sua decisão." : `${r.counts.uncertain} envios ficaram incertos e precisam da sua decisão.`,
      action: "review_uncertain",
    });
  }

  if (r.lastImport && r.lastImport.rejected > 0) {
    const pct = r.lastImport.found > 0 ? r.lastImport.rejected / r.lastImport.found : 0;
    alertas.push({
      level: pct >= 0.1 ? "warning" : "info",
      code: "import_rejects",
      message: `CSV com erros: ${r.lastImport.rejected} de ${r.lastImport.found} linhas não entraram.`,
      action: "view_import",
    });
  }

  return alertas.sort((a, b) => ORDEM[a.level] - ORDEM[b.level]);
}
