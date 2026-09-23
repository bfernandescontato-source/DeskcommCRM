/**
 * O DESPACHANTE — uma rodada do envio de campanhas.
 *
 * Roda a cada minuto (cron `campaign-dispatcher`) e NÃO guarda estado: todo o estado é
 * do banco. Se o processo cair no meio, a rodada seguinte enxerga exatamente o que o
 * banco tem — contato reservado (a lease vence e ele volta), em envio (vira incerto,
 * nunca reenvia sozinho) ou enviado.
 *
 * ─── Por número, um contato por rodada ─────────────────────────────────────────
 * O ritmo mora no intervalo FIXO entre dois envios do mesmo número; a cada rodada cada
 * número manda no máximo UM contato. A reserva no banco é exclusiva por número, então
 * duas rodadas sobrepostas não mandam duas mensagens ao mesmo tempo.
 *
 * ─── A ordem de cada envio (a ordem é o que impede duplicar) ────────────────────
 *   1. `claim_batch`  reserva 1 contato (pending -> queued), com dono e prazo;
 *   2. `begin_send`   o ponto sem volta: confere de novo campanha, número e contato e
 *                     carimba a versão e o destino DE AGORA (queued -> processing);
 *   3. envia          pelo caminho único do CRM (`sendMessageHandler`);
 *   4. `mark_*`       registra o desfecho; se este passo falhar, a lease vence e o
 *                     contato vira `uncertain` — nunca `pending`.
 *
 * Tudo que toca o mundo entra por `DepsDoDespachante`, e é por isso que a orquestração
 * inteira é testável sem banco e sem WhatsApp.
 */
import { linkDeBloqueio, linkDoGrupo, type EnvioDeTexto, type ResultadoDoEnvio } from "./envio";
import { renderizarMensagem } from "./mensagem";
import { decidirEnvio, type DecisaoDeRitmo, type RitmoDoCanal } from "./ritmo";

/** Uma linha de `fn_campaign_dispatch_targets`: campanha rodando + um número dela. */
export interface AlvoDoDespacho {
  organization_id: string;
  campaign_id: string;
  channel_session_id: string;
  channel_status: string;
  channel_archived: boolean;
  channel_provider: string;
  daily_message_limit: number | null;
  channel_policy: "skip_channel" | "pause_campaign";
  tracking_enabled: boolean;
  send_interval_seconds: number;
  daily_cap_per_channel: number | null;
  started_at: string | null;
}

interface Reserva {
  campaign_contact_id: string;
  contact_id: string;
  claim_token: string;
}

interface Decisao {
  decision: "send" | "released" | "channel_unavailable" | "no_destination" | "skipped" | "already_processing" | "lost";
  reason?: string;
  campaign_contact_id?: string;
  campaign_id?: string;
  contact_id?: string;
  channel_session_id?: string;
  message_version_id?: string;
  body?: string;
  destination_url?: string | null;
  tracking_enabled?: boolean;
  tracking_token?: string;
  variables?: Record<string, string>;
}

export interface DepsDoDespachante {
  chamar<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  agora(): Date;
  ritmoDoCanal(alvo: AlvoDoDespacho, agora: Date): Promise<RitmoDoCanal>;
  /** Quantos a campanha já enviou hoje por este número. */
  enviadosHojePelaCampanha(alvo: AlvoDoDespacho, ritmo: RitmoDoCanal, agora: Date): Promise<number>;
  nomeDoContato(orgId: string, contactId: string): Promise<string | null>;
  enviarTexto(envio: EnvioDeTexto): Promise<ResultadoDoEnvio>;
  registrarEnvio(orgId: string, channelId: string, quando: Date): Promise<void>;
  /** Base pública do redirecionador (`/g/<token>`); null = ainda sem rastreio (o link vai cru). */
  baseDoRastreio: string | null;
  /** Auditoria de mudança feita PELO SISTEMA (pausa automática). Só é chamada quando houve efeito. */
  auditarPausa(orgId: string, campaignId: string, motivo: string): void;
  log(nivel: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>): void;
}

export interface ResumoDoDespacho {
  varridos: { released: number; uncertain: number };
  alvos: number;
  enviados: number;
  falhas: number;
  incertos: number;
  pausadas: number;
  concluidas: number;
  /** Por que um número não enviou nesta rodada: `outside_window`, `interval`, `sem_pendente`… */
  motivos: Record<string, number>;
}

const CONCORRENCIA = 8;

function contar(r: Record<string, number>, chave: string): void {
  r[chave] = (r[chave] ?? 0) + 1;
}

export async function despachar(deps: DepsDoDespachante): Promise<ResumoDoDespacho> {
  const resumo: ResumoDoDespacho = {
    varridos: { released: 0, uncertain: 0 },
    alvos: 0,
    enviados: 0,
    falhas: 0,
    incertos: 0,
    pausadas: 0,
    concluidas: 0,
    motivos: {},
  };

  // 1) Quem morreu no meio: reservado volta para a fila; em envio vira incerto.
  resumo.varridos = await deps.chamar<{ released: number; uncertain: number }>("fn_campaign_sweep_leases", { p_limit: 500 });

  // 2) O que está rodando.
  const alvos = (await deps.chamar<AlvoDoDespacho[]>("fn_campaign_dispatch_targets", { p_limit: 500 })) ?? [];
  resumo.alvos = alvos.length;
  const campanhas = new Map<string, AlvoDoDespacho[]>();
  for (const a of alvos) campanhas.set(a.campaign_id, [...(campanhas.get(a.campaign_id) ?? []), a]);

  // 3) Número caído: a política da campanha decide. Nada some da fila — pausar só para de reservar.
  const pausadas = new Set<string>();
  for (const [campaignId, doCanal] of campanhas) {
    const primeiro = doCanal[0]!;
    const caidos = doCanal.filter((a) => a.channel_status !== "WORKING" || a.channel_archived);
    const motivo =
      caidos.length === doCanal.length ? "no_channel" : caidos.length > 0 && primeiro.channel_policy === "pause_campaign" ? "channel_down" : null;
    if (motivo) {
      if (await pausarPeloSistema(deps, primeiro.organization_id, campaignId, motivo)) resumo.pausadas += 1;
      pausadas.add(campaignId);
    }
  }

  // 4) Por número: quem está de pé e a campanha não foi pausada, na ordem de quem começou antes.
  const porNumero = new Map<string, AlvoDoDespacho[]>();
  for (const a of alvos) {
    if (pausadas.has(a.campaign_id) || a.channel_status !== "WORKING" || a.channel_archived) continue;
    const chave = `${a.organization_id}:${a.channel_session_id}`;
    porNumero.set(chave, [...(porNumero.get(chave) ?? []), a]);
  }
  const fila = [...porNumero.values()];
  for (let i = 0; i < fila.length; i += CONCORRENCIA) {
    await Promise.all(
      fila.slice(i, i + CONCORRENCIA).map(async (doNumero) => {
        try {
          await despacharNumero(deps, doNumero, resumo);
        } catch (e) {
          // Um número com problema nunca derruba a rodada dos outros.
          deps.log("error", "[disparos] falha ao despachar um número", {
            channelId: doNumero[0]?.channel_session_id,
            erro: e instanceof Error ? e.message : "unknown",
          });
          contar(resumo.motivos, "erro_no_numero");
        }
      }),
    );
  }

  // 5) Campanha sem mais nada por processar se encerra sozinha.
  for (const [campaignId, doCanal] of campanhas) {
    if (pausadas.has(campaignId)) continue;
    try {
      const concluiu = await deps.chamar<boolean>("fn_campaign_complete_if_done", {
        p_org: doCanal[0]!.organization_id,
        p_campaign: campaignId,
      });
      if (concluiu) resumo.concluidas += 1;
    } catch (e) {
      deps.log("warn", "[disparos] não consegui conferir se a campanha acabou", { campaignId, erro: e instanceof Error ? e.message : "unknown" });
    }
  }
  return resumo;
}

async function pausarPeloSistema(deps: DepsDoDespachante, orgId: string, campaignId: string, motivo: string): Promise<boolean> {
  try {
    const r = await deps.chamar<{ changed: boolean }>("fn_campaign_transition", {
      p_org: orgId,
      p_campaign: campaignId,
      p_action: "pause",
      p_actor: null,
      p_reason: motivo,
    });
    if (r.changed) deps.auditarPausa(orgId, campaignId, motivo);
    return r.changed;
  } catch (e) {
    deps.log("warn", "[disparos] não consegui pausar a campanha", { campaignId, erro: e instanceof Error ? e.message : "unknown" });
    return false;
  }
}

/** Um número, uma rodada: no máximo UM contato, da campanha mais antiga que tiver pendente. */
async function despacharNumero(deps: DepsDoDespachante, campanhas: AlvoDoDespacho[], resumo: ResumoDoDespacho): Promise<void> {
  const primeiro = campanhas[0]!;
  const agora = deps.agora();
  const ritmo = await deps.ritmoDoCanal(primeiro, agora);

  for (const alvo of campanhas) {
    const decisao: DecisaoDeRitmo = decidirEnvio(ritmo, {
      agora,
      intervaloSegundos: alvo.send_interval_seconds,
      capDaCampanha: alvo.daily_cap_per_channel,
      enviadosHojePelaCampanha: alvo.daily_cap_per_channel === null ? 0 : await deps.enviadosHojePelaCampanha(alvo, ritmo, agora),
    });
    if (!decisao.allow) {
      contar(resumo.motivos, decisao.code);
      // O intervalo e o teto são DESTA campanha: a próxima, com outro ritmo, ainda pode enviar.
      // Janela, aquecimento e teto do número valem para todas — sem mais nada a tentar aqui.
      if (decisao.code === "interval" || decisao.code === "campaign_cap") continue;
      return;
    }

    const reservas = await deps.chamar<Reserva[]>("fn_campaign_claim_batch", {
      p_org: alvo.organization_id,
      p_campaign: alvo.campaign_id,
      p_channel: alvo.channel_session_id,
      p_limit: 1,
      p_lease_seconds: 120,
      p_exclusive: true,
    });
    const reserva = reservas?.[0];
    if (!reserva) {
      contar(resumo.motivos, "sem_pendente");
      continue;
    }
    await processarContato(deps, alvo, reserva, agora, resumo);
    return;
  }
}

async function processarContato(
  deps: DepsDoDespachante,
  alvo: AlvoDoDespacho,
  reserva: Reserva,
  agora: Date,
  resumo: ResumoDoDespacho,
): Promise<void> {
  const org = alvo.organization_id;
  const d = await deps.chamar<Decisao>("fn_campaign_begin_send", {
    p_org: org,
    p_campaign_contact: reserva.campaign_contact_id,
    p_claim_token: reserva.claim_token,
    p_send_lease_seconds: 120,
  });

  if (d.decision !== "send") {
    contar(resumo.motivos, `begin_${d.decision}`);
    if (d.decision === "no_destination") await pausarPeloSistema(deps, org, alvo.campaign_id, "no_destination");
    return;
  }

  const token = reserva.claim_token;
  const marcar = <T>(fn: string, args: Record<string, unknown>) =>
    deps.chamar<T>(fn, { p_org: org, p_campaign_contact: reserva.campaign_contact_id, p_claim_token: token, ...args });

  const nome = await deps.nomeDoContato(org, reserva.contact_id);
  const link = linkDoGrupo({
    trackingEnabled: d.tracking_enabled ?? false,
    token: d.tracking_token ?? "",
    destinationUrl: d.destination_url ?? null,
    baseUrl: deps.baseDoRastreio,
  });
  const linkBloqueio = linkDeBloqueio({ token: d.tracking_token ?? "", baseUrl: deps.baseDoRastreio });
  const msg = renderizarMensagem(d.body ?? "", { nome, linkGrupo: link, linkBloqueio, variaveis: d.variables ?? {} });

  // Variável sem valor NUNCA vira texto enviável: seria um `{{produto}}` literal na tela de alguém.
  if (msg.faltando.length > 0) {
    await marcar("fn_campaign_mark_failed", {
      p_error_code: "missing_variable",
      p_error: `Faltou o valor de: ${msg.faltando.join(", ")}`,
      p_retryable: false,
    });
    resumo.falhas += 1;
    return;
  }

  let envio: ResultadoDoEnvio;
  try {
    envio = await deps.enviarTexto({
      orgId: org,
      contactId: reserva.contact_id,
      channelId: alvo.channel_session_id,
      campaignId: alvo.campaign_id,
      campaignContactId: reserva.campaign_contact_id,
      texto: msg.texto,
    });
  } catch (e) {
    // Não sabemos se saiu: NUNCA reenvia sozinho. Uma pessoa olha a conversa e decide.
    const causa = e instanceof Error ? e.message : "unknown";
    await marcar("fn_campaign_mark_uncertain", { p_error_code: "send_threw", p_error: causa.slice(0, 300) });
    resumo.incertos += 1;
    deps.log("error", "[disparos] o envio lançou erro; contato ficou incerto", { campaignContactId: reserva.campaign_contact_id, erro: causa });
    return;
  }

  if (envio.status === "sent") {
    const r = await marcar<string>("fn_campaign_mark_sent", { p_message_id: envio.messageId, p_external_id: envio.externalId });
    resumo.enviados += 1;
    if (r === "lost") contar(resumo.motivos, "mark_sent_lost");
    await deps.registrarEnvio(org, alvo.channel_session_id, agora).catch(() => undefined);
    return;
  }

  if (envio.status === "queued") {
    // O canal não estava pronto e a mensagem nem saiu (o envio já a marcou como falha para ninguém a enviar depois).
    await marcar("fn_campaign_mark_failed", {
      p_error_code: "channel_not_ready",
      p_error: "O número não estava pronto para enviar.",
      p_retryable: true,
      p_max_attempts: 5,
    });
    contar(resumo.motivos, "channel_not_ready");
    return;
  }

  await marcar("fn_campaign_mark_failed", {
    p_error_code: envio.errorCode ?? "send_failed",
    p_error: envio.errorMessage ?? "O envio falhou.",
    p_retryable: false,
  });
  resumo.falhas += 1;
}
