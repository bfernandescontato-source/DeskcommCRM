/**
 * As LEITURAS da Central de Disparos — o que a tela pede: painel geral, métricas, Fila,
 * perfil do contato e o bloco "Agora".
 *
 * Toda leitura filtra a organização à mão (o client é o de service role) e devolve o dado
 * pronto para a tela: nome apresentável, telefone formatado, estado derivado. Nenhuma
 * conta de negócio mora na tela.
 */
import { dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";

import { calcularAlertas, type Alerta } from "./alertas";
import { carregarRitmoDoCanal, decidirEnvio, enviadosHojePelaCampanha, type VetoDeRitmo } from "./ritmo";
import { detalharCampanha, ler, rpc, CampanhaError, type Db } from "./service";
import type { EventoLinha } from "./tipos";
import type { CampaignContactStatus } from "./vocabulario";

const FUSO_PADRAO = "America/Sao_Paulo";

// ── painel geral ────────────────────────────────────────────────────────────

export interface PainelGeral {
  running: number;
  paused: number;
  sent_today: number;
  active: { pending?: number; sent?: number; failed?: number; clicked?: number; replied?: number; joined?: number; left?: number };
}

export async function painelGeral(db: Db, orgId: string, agora = new Date()): Promise<PainelGeral> {
  const org = await ler<{ timezone: string | null }>(db.from("organizations").select("timezone").eq("id", orgId).maybeSingle());
  const desde = dayStartInTz(agora, org?.timezone || FUSO_PADRAO);
  return rpc<PainelGeral>(db, "fn_campaign_dashboard", { p_org: orgId, p_since: desde.toISOString() });
}

// ── métricas ────────────────────────────────────────────────────────────────

export interface MetricasDaCampanha {
  by_version: Array<{ version_no: number; version_id: string; sent: number; clicked: number; replied: number; failed: number }>;
  by_destination: Array<{
    destination_id: string; sequence_no: number; name: string; status: string; capacity: number | null;
    opened_at: string | null; closed_at: string | null; close_reason: string | null;
    directed: number; clicked: number; joined: number; left: number; clicks_raw: number;
  }>;
  by_channel: Array<{ channel_session_id: string; sent: number; failed: number; uncertain: number; last_sent_at: string | null }>;
}

export const metricasDaCampanha = (db: Db, orgId: string, campaignId: string) =>
  rpc<MetricasDaCampanha>(db, "fn_campaign_metrics", { p_org: orgId, p_campaign: campaignId });

// ── Fila ────────────────────────────────────────────────────────────────────

export interface FiltrosDaFila {
  status?: CampaignContactStatus[];
  channel?: string;
  destination?: string;
  version?: string;
  clicked?: boolean;
  replied?: boolean;
  /** Última atividade a partir de / até (ISO). */
  from?: string;
  to?: string;
  q?: string;
  /** Cursor: o `seq` da última linha da página anterior. */
  after: number;
  limit: number;
}

/** O termo da busca, seguro para a gramática do `or=` do PostgREST: só letras, números, `@` e `+`. */
export function termoDaBusca(bruto: string): { texto: string; digitos: string } {
  const texto = bruto
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}@+\s.-]/gu, " ")
    .replace(/[.]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join("*");
  return { texto, digitos: bruto.replace(/\D/g, "") };
}

export interface LinhaDaFila {
  id: string;
  seq: number;
  status: CampaignContactStatus;
  skip_reason: string | null;
  contact_id: string;
  name: string | null;
  phone: string;
  channel: string | null;
  version_no: number | null;
  destination: string | null;
  sent_at: string | null;
  updated_at: string;
  attempts: number;
  last_error_code: string | null;
  clicked_at: string | null;
  replied_at: string | null;
  joined_at: string | null;
  left_at: string | null;
}

interface LinhaCrua {
  id: string; seq: number; status: CampaignContactStatus; skip_reason: string | null;
  sent_at: string | null; updated_at: string; attempts: number; last_error_code: string | null;
  clicked_at: string | null; replied_at: string | null; joined_at: string | null; left_at: string | null;
  contact: { id: string; display_name: string | null; name: string | null; phone_number: string | null } | Array<{ id: string; display_name: string | null; name: string | null; phone_number: string | null }> | null;
  channel: { display_name: string | null; phone_number: string | null } | Array<{ display_name: string | null; phone_number: string | null }> | null;
  version: { version_no: number } | Array<{ version_no: number }> | null;
  destination: { name: string } | Array<{ name: string }> | null;
}

/** O join do PostgREST devolve objeto ou array conforme a cardinalidade inferida. */
const um = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export function rotuloDoNumero(c: { display_name: string | null; phone_number: string | null } | null): string | null {
  if (!c) return null;
  return c.display_name?.trim() || phoneForDisplay(c.phone_number) || null;
}

export function linhaDaFila(l: LinhaCrua): LinhaDaFila {
  const contato = um(l.contact);
  return {
    id: l.id,
    seq: l.seq,
    status: l.status,
    skip_reason: l.skip_reason,
    contact_id: contato?.id ?? "",
    name: nomeDoContato(contato),
    phone: phoneForDisplay(contato?.phone_number),
    channel: rotuloDoNumero(um(l.channel)),
    version_no: um(l.version)?.version_no ?? null,
    destination: um(l.destination)?.name ?? null,
    sent_at: l.sent_at,
    updated_at: l.updated_at,
    attempts: l.attempts,
    last_error_code: l.last_error_code,
    clicked_at: l.clicked_at,
    replied_at: l.replied_at,
    joined_at: l.joined_at,
    left_at: l.left_at,
  };
}

export async function listarFila(db: Db, orgId: string, campaignId: string, f: FiltrosDaFila): Promise<{ linhas: LinhaDaFila[]; proximo: number | null }> {
  let q = db
    .from("campaign_contacts")
    .select(
      "id, seq, status, skip_reason, sent_at, updated_at, attempts, last_error_code, clicked_at, replied_at, joined_at, left_at, " +
        "contact:contacts!inner(id, display_name, name, phone_number), " +
        "channel:channel_sessions(display_name, phone_number), version:campaign_message_versions(version_no), destination:campaign_destinations(name)",
    )
    .eq("organization_id", orgId)
    .eq("campaign_id", campaignId)
    .gt("seq", f.after)
    .order("seq", { ascending: true })
    .limit(f.limit + 1);
  if (f.status && f.status.length > 0) q = q.in("status", f.status);
  if (f.channel) q = q.eq("channel_session_id", f.channel);
  if (f.destination) q = q.eq("destination_id", f.destination);
  if (f.version) q = q.eq("message_version_id", f.version);
  if (f.clicked) q = q.not("clicked_at", "is", null);
  if (f.replied) q = q.not("replied_at", "is", null);
  if (f.from) q = q.gte("updated_at", f.from);
  if (f.to) q = q.lte("updated_at", f.to);
  if (f.q) {
    const { texto, digitos } = termoDaBusca(f.q);
    const partes: string[] = [];
    if (texto.length >= 2) partes.push(`display_name.ilike.*${texto}*`, `name.ilike.*${texto}*`);
    if (digitos.length >= 4) partes.push(`phone_number.ilike.*${digitos}*`);
    // Termo que não vale consulta (só pontuação, 1 letra) não devolve a fila inteira: devolve nada.
    if (partes.length === 0) return { linhas: [], proximo: null };
    q = q.or(partes.join(","), { referencedTable: "contacts" });
  }
  const crua = ((await ler<unknown[]>(q)) ?? []) as LinhaCrua[];
  const temMais = crua.length > f.limit;
  const pagina = temMais ? crua.slice(0, f.limit) : crua;
  const ultima = pagina[pagina.length - 1];
  return { linhas: pagina.map(linhaDaFila), proximo: temMais && ultima ? ultima.seq : null };
}

// ── estado derivado do contato ──────────────────────────────────────────────

export type EstadoDoContato = "NO_GRUPO" | "SAIU_DO_GRUPO" | "RESPONDEU" | "CLICOU" | "ENVIADO" | "PENDENTE" | "PROCESSANDO" | "FALHOU" | "INCERTO" | "IGNORADO" | "CANCELADO";

/**
 * Onde a pessoa está AGORA, do estágio mais avançado para o menos. Engajamento não é status:
 * quem foi enviado, clicou, respondeu e entrou no grupo é, hoje, "no grupo".
 */
export function estadoDoContato(c: { status: CampaignContactStatus; clicked_at: string | null; replied_at: string | null; joined_at: string | null; left_at: string | null }): EstadoDoContato {
  if (c.status === "sent") {
    if (c.left_at) return "SAIU_DO_GRUPO";
    if (c.joined_at) return "NO_GRUPO";
    if (c.replied_at) return "RESPONDEU";
    if (c.clicked_at) return "CLICOU";
    return "ENVIADO";
  }
  return { pending: "PENDENTE", queued: "PENDENTE", processing: "PROCESSANDO", failed: "FALHOU", uncertain: "INCERTO", skipped: "IGNORADO", cancelled: "CANCELADO" }[c.status] as EstadoDoContato;
}

// ── perfil do contato ───────────────────────────────────────────────────────

export interface EventoDoContato extends EventoLinha {
  actor_name: string | null;
}

export interface PerfilDoContato {
  id: string;
  campaign_id: string;
  state: EstadoDoContato;
  status: CampaignContactStatus;
  contact: { id: string; name: string | null; phone: string };
  channel: string | null;
  version_no: number | null;
  destination: string | null;
  attempts: number;
  last_error_code: string | null;
  last_error: string | null;
  variables: Record<string, string>;
  imported_at: string;
  import_filename: string | null;
  sent_at: string | null;
  clicked_at: string | null;
  replied_at: string | null;
  joined_at: string | null;
  left_at: string | null;
  /** O texto exato que foi enviado, e a conversa no Inbox onde a resposta cai. */
  message: { id: string; body: string | null; conversation_id: string; status: string } | null;
  events: EventoDoContato[];
}

export async function perfilDoContato(db: Db, orgId: string, campaignId: string, ccId: string): Promise<PerfilDoContato> {
  const c = await ler<
    Record<string, unknown> & {
      id: string; campaign_id: string; status: CampaignContactStatus; attempts: number; last_error_code: string | null; last_error: string | null;
      variables: Record<string, string> | null; created_at: string; sent_at: string | null; clicked_at: string | null; replied_at: string | null; joined_at: string | null; left_at: string | null;
      contact: unknown; channel: unknown; version: unknown; destination: unknown; message: unknown; import: unknown;
    }
  >(
    db
      .from("campaign_contacts")
      .select(
        "id, campaign_id, status, attempts, last_error_code, last_error, variables, created_at, sent_at, clicked_at, replied_at, joined_at, left_at, " +
          "contact:contacts(id, display_name, name, phone_number), channel:channel_sessions(display_name, phone_number), " +
          "version:campaign_message_versions(version_no), destination:campaign_destinations(name), " +
          "message:messages(id, body, conversation_id, status), import:campaign_imports(filename)",
      )
      .eq("organization_id", orgId)
      .eq("campaign_id", campaignId)
      .eq("id", ccId)
      .maybeSingle(),
  );
  if (!c) throw new CampanhaError({ code: "contact_not_found", status: 404, message: "Contato não encontrado nesta campanha." });

  const eventos =
    (await ler<EventoLinha[]>(
      db
        .from("campaign_events")
        .select("id, campaign_contact_id, kind, occurred_at, actor_user_id, message_version_id, destination_id, channel_session_id, payload")
        .eq("organization_id", orgId)
        .eq("campaign_contact_id", ccId)
        .order("occurred_at", { ascending: true })
        .order("id", { ascending: true }),
    )) ?? [];
  const nomes = await nomesDeQuemAgiu(db, orgId, eventos.map((e) => e.actor_user_id));

  const contato = um(c.contact as { id: string; display_name: string | null; name: string | null; phone_number: string | null } | null);
  const msg = um(c.message as { id: string; body: string | null; conversation_id: string; status: string } | null);
  return {
    id: c.id,
    campaign_id: c.campaign_id,
    state: estadoDoContato(c),
    status: c.status,
    contact: { id: contato?.id ?? "", name: nomeDoContato(contato), phone: phoneForDisplay(contato?.phone_number) },
    channel: rotuloDoNumero(um(c.channel as { display_name: string | null; phone_number: string | null } | null)),
    version_no: um(c.version as { version_no: number } | null)?.version_no ?? null,
    destination: um(c.destination as { name: string } | null)?.name ?? null,
    attempts: c.attempts,
    last_error_code: c.last_error_code,
    last_error: c.last_error,
    variables: c.variables ?? {},
    imported_at: c.created_at,
    import_filename: um(c.import as { filename: string } | null)?.filename ?? null,
    sent_at: c.sent_at,
    clicked_at: c.clicked_at,
    replied_at: c.replied_at,
    joined_at: c.joined_at,
    left_at: c.left_at,
    message: msg ? { id: msg.id, body: msg.body, conversation_id: msg.conversation_id, status: msg.status } : null,
    events: eventos.map((e) => ({ ...e, actor_name: e.actor_user_id ? (nomes.get(e.actor_user_id) ?? null) : null })),
  };
}

// ── nomes de quem agiu ──────────────────────────────────────────────────────

export async function nomesDeQuemAgiu(db: Db, orgId: string, ids: Array<string | null>): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter((i): i is string => !!i))];
  if (unicos.length === 0) return new Map();
  const linhas = (await rpc<Array<{ id: string; name: string }> | null>(db, "fn_campaign_actor_names", { p_org: orgId, p_ids: unicos })) ?? [];
  return new Map(linhas.map((l) => [l.id, l.name]));
}

/** A resolução de um contato INCERTO por uma pessoa: enviado, tentar de novo ou falhou. */
export const resolverIncerto = (db: Db, orgId: string, ccId: string, resolution: "sent" | "retry" | "failed", actorId: string) =>
  rpc<"ok" | "already" | "not_uncertain">(db, "fn_campaign_resolve_uncertain", { p_org: orgId, p_campaign_contact: ccId, p_resolution: resolution, p_actor: actorId });

// ── "Agora" ─────────────────────────────────────────────────────────────────

export interface Agora {
  status: string;
  status_reason: string | null;
  last_sent: { at: string; contact: string | null; phone: string; channel: string | null } | null;
  in_flight: { contact: string | null; channel: string | null } | null;
  remaining: number;
  current_destination: string | null;
  channels: Array<{ id: string; label: string; status: string; sent: number; failed: number; last_sent_at: string | null; can_send_now: boolean; next_at: string | null; blocked_by: VetoDeRitmo | null }>;
  /** Quando o próximo envio pode sair (o primeiro número liberado); null = agora, ou nada a esperar. */
  next_at: string | null;
}

export async function agoraDaCampanha(db: Db, orgId: string, campaignId: string, agora = new Date()): Promise<Agora> {
  const det = await detalharCampanha(db, orgId, campaignId);
  const c = det.campaign;
  const metricas = await metricasDaCampanha(db, orgId, campaignId);

  const [ultimo, emVoo, limites] = await Promise.all([
    ler<Array<{ sent_at: string; contact: unknown; channel: unknown }>>(
      db
        .from("campaign_contacts")
        .select("sent_at, contact:contacts(display_name, name, phone_number), channel:channel_sessions(display_name, phone_number)")
        .eq("organization_id", orgId)
        .eq("campaign_id", campaignId)
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1),
    ),
    ler<Array<{ contact: unknown; channel: unknown }>>(
      db
        .from("campaign_contacts")
        .select("contact:contacts(display_name, name, phone_number), channel:channel_sessions(display_name, phone_number)")
        .eq("organization_id", orgId)
        .eq("campaign_id", campaignId)
        .in("status", ["queued", "processing"])
        .limit(1),
    ),
    ler<Array<{ id: string; provider: string; daily_message_limit: number | null }>>(
      db.from("channel_sessions").select("id, provider, daily_message_limit").eq("organization_id", orgId).in("id", det.channels.map((x) => x.channel_session_id)),
    ),
  ]);

  const limitePorCanal = new Map((limites ?? []).map((l) => [l.id, l]));
  const canais: Agora["channels"] = [];
  for (const ch of det.channels.filter((x) => x.enabled)) {
    const m = metricas.by_channel.find((x) => x.channel_session_id === ch.channel_session_id);
    const base = { id: ch.channel_session_id, label: rotuloDoNumero(ch.session) ?? "Número", status: ch.session?.status ?? "STOPPED", sent: m?.sent ?? 0, failed: m?.failed ?? 0, last_sent_at: m?.last_sent_at ?? null };
    const lim = limitePorCanal.get(ch.channel_session_id);
    if (!lim || base.status !== "WORKING") {
      canais.push({ ...base, can_send_now: false, next_at: null, blocked_by: null });
      continue;
    }
    const ritmo = await carregarRitmoDoCanal(db, orgId, ch.channel_session_id, agora, { provider: lim.provider, dailyMessageLimit: lim.daily_message_limit });
    const noDia = c.daily_cap_per_channel === null ? 0 : await enviadosHojePelaCampanha(db, campaignId, ch.channel_session_id, dayStartInTz(agora, ritmo.knobs.timezone));
    const d = decidirEnvio(ritmo, { agora, intervaloSegundos: c.send_interval_seconds, capDaCampanha: c.daily_cap_per_channel, enviadosHojePelaCampanha: noDia });
    canais.push(d.allow ? { ...base, can_send_now: true, next_at: null, blocked_by: null } : { ...base, can_send_now: false, next_at: d.ate ? d.ate.toISOString() : null, blocked_by: d.code });
  }
  const proximos = canais.filter((x) => !x.can_send_now && x.next_at).map((x) => x.next_at as string).sort();
  const alguemPode = canais.some((x) => x.can_send_now);
  const u = ultimo?.[0];
  const ucontato = u ? um(u.contact as { display_name: string | null; name: string | null; phone_number: string | null } | null) : null;
  const v = emVoo?.[0];

  return {
    status: c.status,
    status_reason: c.status_reason,
    last_sent: u ? { at: u.sent_at, contact: nomeDoContato(ucontato), phone: phoneForDisplay(ucontato?.phone_number), channel: rotuloDoNumero(um(u.channel as { display_name: string | null; phone_number: string | null } | null)) } : null,
    in_flight: v ? { contact: nomeDoContato(um(v.contact as { display_name: string | null; name: string | null; phone_number: string | null } | null)), channel: rotuloDoNumero(um(v.channel as { display_name: string | null; phone_number: string | null } | null)) } : null,
    remaining: det.counts.pending + det.counts.queued + det.counts.processing,
    current_destination: det.destinations.find((d) => d.id === c.active_destination_id)?.name ?? null,
    channels: canais,
    next_at: alguemPode ? null : (proximos[0] ?? null),
  };
}

// ── alertas de uma campanha ─────────────────────────────────────────────────

export async function alertasDaCampanha(db: Db, orgId: string, campaignId: string): Promise<Alerta[]> {
  const [det, metricas, imp] = await Promise.all([
    detalharCampanha(db, orgId, campaignId),
    metricasDaCampanha(db, orgId, campaignId),
    ler<Array<{ id: string }>>(db.from("campaign_imports").select("id").eq("organization_id", orgId).eq("campaign_id", campaignId).eq("status", "done").order("finished_at", { ascending: false }).limit(1)),
  ]);
  let lastImport: { rejected: number; found: number } | null = null;
  const ultima = imp?.[0];
  if (ultima) {
    const r = await rpc<{ rejected: number; found: number }>(db, "fn_campaign_import_summary", { p_org: orgId, p_import: ultima.id });
    lastImport = { rejected: r.rejected, found: r.found };
  }
  return calcularAlertas({
    status: det.campaign.status,
    statusReason: det.campaign.status_reason,
    counts: det.counts,
    channels: det.channels.map((c) => ({ label: rotuloDoNumero(c.session) ?? "Número", status: c.session?.status ?? "STOPPED", enabled: c.enabled })),
    destinations: metricas.by_destination.map((d) => ({
      name: d.name, status: d.status, capacity: d.capacity, directed: d.directed, joined: d.joined, left: d.left,
      measured: det.destinations.find((x) => x.id === d.destination_id)?.group_chat_id != null,
    })),
    lastImport,
  });
}
