/**
 * Serviço da Central de Disparos — a única porta do servidor para as tabelas
 * `campaign_*`.
 *
 * TODA escrita é uma chamada às funções `fn_campaign_*` (a máquina de estados
 * mora no banco, não aqui); este arquivo só traduz argumentos e erros. Toda função
 * recebe `orgId` já resolvido de fonte confiável (cookie validado / papel checado
 * por `requireRole`) — nunca do corpo da requisição — e o repassa ao banco, que
 * o confere contra a campanha.
 *
 * O client é o de service role (as funções são executáveis só por ele), então o
 * filtro de organização é MANUAL em toda leitura: sem ele, um id de campanha de
 * outra organização seria lido.
 *
 * `lib/database.types.ts` ainda não conhece estas tabelas (o arquivo é gerado a
 * partir do banco; regenerá-lo exige o CLI do Supabase), então o client é tipado
 * de forma frouxa e os formatos das linhas estão em `./tipos`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

import { erroDaCampanha, type ErroDeCampanha } from "./erros";
import type {
  CampanhaLinha,
  CanalDaCampanha,
  Contagens,
  DestinoLinha,
  EventoLinha,
  VersaoLinha,
} from "./tipos";
import type { AcaoDaApi, AtualizarCampanhaInput, CriarCampanhaInput, DestinoInput, VersaoInput } from "./schemas";

export type Db = SupabaseClient;

/** O client de service role, sem o tipo do banco (as tabelas novas ainda não estão nele). */
export function dbDeCampanhas(): Db {
  return createAdminClient() as unknown as Db;
}

export class CampanhaError extends Error {
  readonly erro: ErroDeCampanha;
  constructor(erro: ErroDeCampanha) {
    super(erro.message);
    this.name = "CampanhaError";
    this.erro = erro;
  }
}

export async function rpc<T>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new CampanhaError(erroDaCampanha(error));
  return data as T;
}

export async function ler<T>(consulta: PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>): Promise<T | null> {
  const { data, error } = await consulta;
  if (error) throw new CampanhaError(erroDaCampanha(error));
  return data;
}

const COLUNAS_DA_CAMPANHA =
  "id, organization_id, name, status, status_reason, active_version_id, active_destination_id, tracking_enabled, channel_policy, send_interval_seconds, daily_cap_per_channel, revision, started_at, paused_at, finished_at, created_by, created_at, updated_at";
const COLUNAS_DA_VERSAO = "id, version_no, body, created_by, created_at, activated_at, superseded_at";
const COLUNAS_DO_DESTINO =
  "id, sequence_no, name, invite_url, group_chat_id, capacity, status, opened_at, closed_at, close_reason, created_at";

// ── escrita ─────────────────────────────────────────────────────────────────

export async function criarCampanha(db: Db, orgId: string, actorId: string, input: CriarCampanhaInput): Promise<string> {
  return rpc<string>(db, "fn_campaign_create", {
    p_org: orgId,
    p_name: input.name,
    p_actor: actorId,
    p_tracking_enabled: input.tracking_enabled,
    p_channel_policy: input.channel_policy,
  });
}

export interface ResultadoDeConfiguracao {
  changed: boolean;
  changes?: Record<string, { from: unknown; to: unknown }>;
}

export async function atualizarConfiguracao(
  db: Db,
  orgId: string,
  campaignId: string,
  actorId: string,
  input: AtualizarCampanhaInput,
): Promise<ResultadoDeConfiguracao> {
  return rpc<ResultadoDeConfiguracao>(db, "fn_campaign_update_settings", {
    p_org: orgId,
    p_campaign: campaignId,
    p_actor: actorId,
    p_name: input.name ?? null,
    p_tracking_enabled: input.tracking_enabled ?? null,
    p_channel_policy: input.channel_policy ?? null,
    p_send_interval_seconds: input.send_interval_seconds ?? null,
    p_daily_cap_per_channel: input.daily_cap_per_channel ?? null,
    // `null` explícito = voltar ao teto do número; ausente = não mexer.
    p_clear_daily_cap: input.daily_cap_per_channel === null,
  });
}

export interface ResultadoDeTransicao {
  changed: boolean;
  from: string;
  to: string;
  cancelled_contacts?: number;
}

export async function transicionar(
  db: Db,
  orgId: string,
  campaignId: string,
  actorId: string,
  action: AcaoDaApi,
  reason?: string,
): Promise<ResultadoDeTransicao> {
  return rpc<ResultadoDeTransicao>(db, "fn_campaign_transition", {
    p_org: orgId,
    p_campaign: campaignId,
    p_action: action,
    p_actor: actorId,
    p_reason: reason ?? null,
  });
}

export async function definirCanais(
  db: Db,
  orgId: string,
  campaignId: string,
  actorId: string,
  channelIds: string[],
): Promise<{ added: number; removed: number }> {
  return rpc(db, "fn_campaign_set_channels", {
    p_org: orgId,
    p_campaign: campaignId,
    p_channels: channelIds,
    p_actor: actorId,
  });
}

export interface ResultadoDeVersao {
  version_id: string;
  version_no: number;
  activated: boolean;
  previous_version_no: number | null;
}

export async function criarVersao(
  db: Db,
  orgId: string,
  campaignId: string,
  actorId: string,
  input: VersaoInput,
): Promise<ResultadoDeVersao> {
  return rpc<ResultadoDeVersao>(db, "fn_campaign_create_version", {
    p_org: orgId,
    p_campaign: campaignId,
    p_body: input.body,
    p_actor: actorId,
    p_activate: input.activate,
    p_based_on_version_no: input.based_on_version_no ?? null,
  });
}

export interface ResultadoDeDestino {
  destination_id: string;
  sequence_no: number;
  activated: boolean;
  switch: { changed: boolean; previous_destination_id?: string | null } | null;
}

export async function cadastrarDestino(
  db: Db,
  orgId: string,
  campaignId: string,
  actorId: string,
  input: DestinoInput,
): Promise<ResultadoDeDestino> {
  return rpc<ResultadoDeDestino>(db, "fn_campaign_add_destination", {
    p_org: orgId,
    p_campaign: campaignId,
    p_name: input.name,
    p_invite_url: input.invite_url,
    p_group_chat_id: input.group_chat_id ?? null,
    p_capacity: input.capacity ?? null,
    p_actor: actorId,
    p_activate: input.activate,
    p_expected_current: input.expected_current ?? null,
    p_close_reason: input.close_reason,
  });
}

export async function trocarDestino(
  db: Db,
  orgId: string,
  campaignId: string,
  destinationId: string,
  actorId: string,
  opcoes: { expectedCurrent?: string | null; closeReason?: "full" | "manual" },
): Promise<{ changed: boolean; destination_id: string; previous_destination_id?: string | null }> {
  return rpc(db, "fn_campaign_switch_destination", {
    p_org: orgId,
    p_campaign: campaignId,
    p_destination: destinationId,
    p_actor: actorId,
    p_close_reason: opcoes.closeReason ?? "full",
    p_expected_current: opcoes.expectedCurrent ?? null,
  });
}

// ── leitura ─────────────────────────────────────────────────────────────────

export async function contagens(db: Db, orgId: string, campaignId: string): Promise<Contagens> {
  return rpc<Contagens>(db, "fn_campaign_counts", { p_org: orgId, p_campaign: campaignId });
}

export interface CampanhaResumo extends CampanhaLinha {
  counts: Contagens;
}

/** As campanhas da organização, mais recentes primeiro, com o placar de cada uma. */
export async function listarCampanhas(db: Db, orgId: string, limite = 50): Promise<CampanhaResumo[]> {
  const linhas =
    (await ler<CampanhaLinha[]>(
      db
        .from("campaigns")
        .select(COLUNAS_DA_CAMPANHA)
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(Math.min(Math.max(limite, 1), 100)),
    )) ?? [];
  return Promise.all(linhas.map(async (c) => ({ ...c, counts: await contagens(db, orgId, c.id) })));
}

export interface CampanhaDetalhada {
  campaign: CampanhaLinha;
  versions: VersaoLinha[];
  destinations: DestinoLinha[];
  channels: CanalDaCampanha[];
  counts: Contagens;
}

export async function detalharCampanha(db: Db, orgId: string, campaignId: string): Promise<CampanhaDetalhada> {
  const campaign = await ler<CampanhaLinha>(
    db.from("campaigns").select(COLUNAS_DA_CAMPANHA).eq("organization_id", orgId).eq("id", campaignId).maybeSingle(),
  );
  if (!campaign) throw new CampanhaError(erroDaCampanha({ message: "campaign_not_found" }));

  const [versions, destinations, canais, counts] = await Promise.all([
    ler<VersaoLinha[]>(
      db.from("campaign_message_versions").select(COLUNAS_DA_VERSAO).eq("organization_id", orgId).eq("campaign_id", campaignId).order("version_no", { ascending: false }),
    ),
    ler<DestinoLinha[]>(
      db.from("campaign_destinations").select(COLUNAS_DO_DESTINO).eq("organization_id", orgId).eq("campaign_id", campaignId).order("sequence_no", { ascending: true }),
    ),
    ler<Array<{ channel_session_id: string; enabled: boolean; session: CanalDaCampanha["session"] | CanalDaCampanha["session"][] }>>(
      db
        .from("campaign_channels")
        .select("channel_session_id, enabled, session:channel_sessions(id, display_name, phone_number, status)")
        .eq("organization_id", orgId)
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: true }),
    ),
    contagens(db, orgId, campaignId),
  ]);

  return {
    campaign,
    versions: versions ?? [],
    destinations: destinations ?? [],
    // O join do PostgREST devolve objeto ou array conforme a cardinalidade inferida.
    channels: (canais ?? []).map((c) => ({
      channel_session_id: c.channel_session_id,
      enabled: c.enabled,
      session: Array.isArray(c.session) ? (c.session[0] ?? null) : c.session,
    })),
    counts,
  };
}

// ── linha do tempo (Atividade) ──────────────────────────────────────────────

interface CursorDeEventos {
  t: string;
  id: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codificarCursorDeEventos(c: CursorDeEventos): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Estrito: o cursor vira filtro do PostgREST, então só passa o que tem exatamente a forma esperada. */
export function decodificarCursorDeEventos(bruto: string): CursorDeEventos | null {
  try {
    const c = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as Partial<CursorDeEventos>;
    if (typeof c.t === "string" && typeof c.id === "string" && ISO.test(c.t) && UUID.test(c.id)) {
      return { t: c.t, id: c.id };
    }
  } catch {
    /* cursor inválido cai no null */
  }
  return null;
}

export async function listarEventos(
  db: Db,
  orgId: string,
  campaignId: string,
  opcoes: { cursor?: string; limit: number; contactCampaignId?: string },
): Promise<{ eventos: EventoLinha[]; nextCursor: string | null }> {
  let consulta = db
    .from("campaign_events")
    .select("id, campaign_contact_id, kind, occurred_at, actor_user_id, message_version_id, destination_id, channel_session_id, payload")
    .eq("organization_id", orgId)
    .eq("campaign_id", campaignId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(opcoes.limit + 1);
  if (opcoes.contactCampaignId) consulta = consulta.eq("campaign_contact_id", opcoes.contactCampaignId);
  if (opcoes.cursor) {
    const c = decodificarCursorDeEventos(opcoes.cursor);
    if (!c) throw new CampanhaError({ code: "validation_failed", status: 422, message: "Cursor inválido." });
    consulta = consulta.or(`occurred_at.lt.${c.t},and(occurred_at.eq.${c.t},id.lt.${c.id})`);
  }
  const linhas = (await ler<EventoLinha[]>(consulta)) ?? [];
  const temMais = linhas.length > opcoes.limit;
  const pagina = temMais ? linhas.slice(0, opcoes.limit) : linhas;
  const ultimo = pagina[pagina.length - 1];
  return {
    eventos: pagina,
    nextCursor: temMais && ultimo ? codificarCursorDeEventos({ t: ultimo.occurred_at, id: ultimo.id }) : null,
  };
}
