/**
 * O RITMO DE ENVIO DE UMA CAMPANHA — quando um número PODE mandar a próxima mensagem.
 *
 * A régua é a da casa (`lib/agent-engine/pacing`): janela de horário no fuso da
 * organização, aquecimento por idade do número e teto diário do canal
 * (`channel_sessions.daily_message_limit`). Reusar é o ponto: uma segunda régua faria a
 * tela prometer um limite e a campanha aplicar outro.
 *
 * ─── O que esta campanha NÃO usa dessa régua ───────────────────────────────────
 * O jitter (sorteio de atraso) e o espaçamento aleatório. O intervalo entre dois envios
 * do mesmo número é FIXO e escolhido pelo operador (`send_interval_seconds`): é um limite
 * de uso que ele enxerga e controla, não uma tentativa de parecer outra coisa. Por isso o
 * `decidePacing` é chamado com `jitterMaxMs: 0` e `rng: () => 0` — o sorteio não tem por
 * onde entrar — e o intervalo é conferido aqui, contra o último envio registrado.
 *
 * O último envio e o total do dia vêm de `pacing_ledger`, que a IA também alimenta: a
 * campanha respeita o que já saiu pelo número, e a IA respeita o que a campanha mandou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PACING_DEFAULTS, type PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import { dayStartInTz, decidePacing, type PacingState } from "@/lib/agent-engine/pacing/engine";
import { parseWarmupCaps } from "@/lib/agent-engine/pacing/store";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";

export interface RitmoDoCanal {
  knobs: PacingKnobs;
  state: PacingState;
  /** Teto diário absoluto do número; null = sem limite conhecido. */
  crmDailyLimit: number | null;
  /** O canal tem risco de banimento por volume? (capability, nunca o nome do provider.) */
  banRisk: boolean;
}

export type VetoDeRitmo = "outside_window" | "warmup_cap" | "daily_cap" | "interval" | "campaign_cap";

export type DecisaoDeRitmo = { allow: true } | { allow: false; code: VetoDeRitmo; ate: Date | null };

export interface PedidoDeRitmo {
  agora: Date;
  /** Intervalo fixo entre dois envios do mesmo número. */
  intervaloSegundos: number;
  /** Teto da CAMPANHA por número por dia; null = só vale o do número. */
  capDaCampanha: number | null;
  /** Quantos ESTA campanha já enviou hoje por este número. */
  enviadosHojePelaCampanha: number;
}

/** Decide se o número pode enviar agora. Pura: a mesma entrada dá sempre a mesma resposta. */
export function decidirEnvio(ritmo: RitmoDoCanal, pedido: PedidoDeRitmo): DecisaoDeRitmo {
  const d = decidePacing({
    now: pedido.agora,
    // Sem sorteio e sem o espaçamento da IA: o intervalo desta campanha é conferido abaixo.
    knobs: { ...ritmo.knobs, throttleMs: 0, jitterMaxMs: 0 },
    state: ritmo.state,
    crmDailyLimit: ritmo.crmDailyLimit,
    banRisk: ritmo.banRisk,
    rng: () => 0,
  });
  if (!d.allow) return { allow: false, code: d.code, ate: d.nextAllowedAt };

  const ultimo = ritmo.state.lastSentAt;
  if (ultimo) {
    const liberaEm = ultimo.getTime() + pedido.intervaloSegundos * 1000;
    if (liberaEm > pedido.agora.getTime()) return { allow: false, code: "interval", ate: new Date(liberaEm) };
  }
  if (pedido.capDaCampanha !== null && pedido.enviadosHojePelaCampanha >= pedido.capDaCampanha) {
    return { allow: false, code: "campaign_cap", ate: null };
  }
  return { allow: true };
}

interface LinhaDeKnobs {
  throttle_ms: number | null;
  jitter_max_ms: number | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allow_sunday: boolean | null;
  timezone: string | null;
  warmup_daily_caps: unknown;
  number_activated_at: string | null;
}

/** Knobs efetivos do número: a linha de `channel_knobs` (se houver) por cima dos padrões. */
export function knobsDaLinha(l: LinhaDeKnobs | null): { knobs: PacingKnobs; ativadoEm: Date | null } {
  if (!l) return { knobs: { ...PACING_DEFAULTS }, ativadoEm: null };
  const passos = l.warmup_daily_caps === null ? null : parseWarmupCaps(l.warmup_daily_caps);
  return {
    knobs: {
      throttleMs: l.throttle_ms ?? PACING_DEFAULTS.throttleMs,
      jitterMaxMs: l.jitter_max_ms ?? PACING_DEFAULTS.jitterMaxMs,
      windowStartHour: l.window_start_hour ?? PACING_DEFAULTS.windowStartHour,
      windowEndHour: l.window_end_hour ?? PACING_DEFAULTS.windowEndHour,
      allowSunday: l.allow_sunday ?? PACING_DEFAULTS.allowSunday,
      timezone: l.timezone ?? PACING_DEFAULTS.timezone,
      // Knob inválido cai nos degraus conservadores, nunca em "sem teto".
      warmupDailyCaps: passos ?? PACING_DEFAULTS.warmupDailyCaps,
    },
    ativadoEm: l.number_activated_at ? new Date(l.number_activated_at) : null,
  };
}

export async function carregarRitmoDoCanal(
  db: SupabaseClient,
  orgId: string,
  channelId: string,
  agora: Date,
  canal: { provider: string; dailyMessageLimit: number | null },
): Promise<RitmoDoCanal> {
  const { data: linha } = await db
    .from("channel_knobs")
    .select("throttle_ms, jitter_max_ms, window_start_hour, window_end_hour, allow_sunday, timezone, warmup_daily_caps, number_activated_at")
    .eq("organization_id", orgId)
    .eq("channel_session_id", channelId)
    .maybeSingle();
  const { knobs, ativadoEm } = knobsDaLinha((linha as LinhaDeKnobs | null) ?? null);

  const inicioDoDia = dayStartInTz(agora, knobs.timezone).toISOString();
  const [{ data: ultimo }, { count }] = await Promise.all([
    db
      .from("pacing_ledger")
      .select("sent_at")
      .eq("organization_id", orgId)
      .eq("channel_session_id", channelId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("pacing_ledger")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("channel_session_id", channelId)
      .gte("sent_at", inicioDoDia),
  ]);

  return {
    knobs,
    state: {
      lastSentAt: ultimo ? new Date((ultimo as { sent_at: string }).sent_at) : null,
      sentToday: count ?? 0,
      numberActivatedAt: ativadoEm,
    },
    crmDailyLimit: canal.dailyMessageLimit,
    banRisk: capabilitiesOf(canal.provider as ChannelProvider).banRisk,
  };
}

/** Quantos esta campanha enviou hoje por este número (desde a meia-noite local da organização). */
export async function enviadosHojePelaCampanha(
  db: SupabaseClient,
  campaignId: string,
  channelId: string,
  desde: Date,
): Promise<number> {
  const { count } = await db
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("channel_session_id", channelId)
    .eq("status", "sent")
    .gte("sent_at", desde.toISOString());
  return count ?? 0;
}

/** Registra um envio efetivado no ledger compartilhado com a IA. Falhar aqui nunca desfaz o envio. */
export async function registrarEnvioNoLedger(db: SupabaseClient, orgId: string, channelId: string, quando: Date): Promise<void> {
  await db.from("pacing_ledger").insert({ organization_id: orgId, channel_session_id: channelId, sent_at: quando.toISOString() });
}
