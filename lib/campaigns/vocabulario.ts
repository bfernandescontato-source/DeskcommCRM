/**
 * O vocabulário da Central de Disparos — UMA fonte para o banco e para a tela.
 *
 * Cada lista espelha um CHECK de `supabase/migrations/20260921180000_0280_*`; o
 * invariante `vocabulario-banco-x-typescript` reprova o dia em que uma dessas
 * listas e o CHECK discordarem. O TypeScript deriva os tipos daqui, então um
 * valor novo entra em um lugar só (e no banco, na mesma migration).
 */

/** Estados da CAMPANHA. Máquina de estados, não um punhado de booleans. */
export const CAMPAIGN_STATUSES = [
  "draft",
  "ready",
  "running",
  "paused",
  "completed",
  "cancelled",
  "error",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** O que fazer quando um número cai no meio da campanha. */
export const CAMPAIGN_CHANNEL_POLICIES = ["skip_channel", "pause_campaign"] as const;
export type CampaignChannelPolicy = (typeof CAMPAIGN_CHANNEL_POLICIES)[number];

/**
 * Estado do ENVIO de um contato. Clique, resposta, entrada e saída de grupo NÃO
 * estão aqui de propósito: são engajamento (carimbos), e a mesma pessoa pode estar
 * `sent` e ter clicado, respondido e entrado ao mesmo tempo.
 */
export const CAMPAIGN_CONTACT_STATUSES = [
  "pending",
  "queued",
  "processing",
  "sent",
  "failed",
  "uncertain",
  "skipped",
  "cancelled",
] as const;
export type CampaignContactStatus = (typeof CAMPAIGN_CONTACT_STATUSES)[number];

/** Por que um contato foi ignorado no momento de enviar. */
export const CAMPAIGN_SKIP_REASONS = [
  "blocked",
  "no_phone",
  "declined_marketing",
  "anonymized",
  "merged",
] as const;
export type CampaignSkipReason = (typeof CAMPAIGN_SKIP_REASONS)[number];

export const CAMPAIGN_DESTINATION_STATUSES = ["queued", "active", "closed"] as const;
export type CampaignDestinationStatus = (typeof CAMPAIGN_DESTINATION_STATUSES)[number];

export const CAMPAIGN_DESTINATION_CLOSE_REASONS = ["full", "manual", "campaign_ended"] as const;
export type CampaignDestinationCloseReason = (typeof CAMPAIGN_DESTINATION_CLOSE_REASONS)[number];

/** Tipos de evento da linha do tempo (campanha inteira e de cada contato). */
export const CAMPAIGN_EVENT_KINDS = [
  "created",
  "ready",
  "started",
  "paused",
  "resumed",
  "completed",
  "cancelled",
  "errored",
  "imported",
  "settings_changed",
  "version_created",
  "version_activated",
  "destination_added",
  "destination_changed",
  "channel_added",
  "channel_removed",
  "sent",
  "send_failed",
  "uncertain",
  "skipped",
  "clicked",
  "replied",
  "joined",
  "left",
  "removed",
] as const;
export type CampaignEventKind = (typeof CAMPAIGN_EVENT_KINDS)[number];

/**
 * Ações da máquina de estados (`fn_campaign_transition`). Quem chama a rota
 * escolhe a ação; o banco decide se a transição é válida a partir do estado atual.
 */
export const CAMPAIGN_ACTIONS = ["ready", "start", "pause", "resume", "complete", "cancel", "fail"] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

/** Estados dos quais uma campanha nunca sai. */
export const CAMPAIGN_TERMINAL_STATUSES: readonly CampaignStatus[] = ["completed", "cancelled"];

/** Estados de uma importação de CSV (`campaign_imports.status`). */
export const CAMPAIGN_IMPORT_STATUSES = ["uploaded", "validated", "importing", "done", "cancelled"] as const;
export type CampaignImportStatus = (typeof CAMPAIGN_IMPORT_STATUSES)[number];

/** Estado de cada linha do arquivo dentro da staging (`campaign_import_rows.status`). */
export const CAMPAIGN_IMPORT_ROW_STATUSES = ["raw", "valid", "rejected", "imported"] as const;
export type CampaignImportRowStatus = (typeof CAMPAIGN_IMPORT_ROW_STATUSES)[number];

/** Por que uma linha do arquivo não entrou (`campaign_import_rows.reason`). */
export const CAMPAIGN_IMPORT_REJECT_REASONS = [
  "empty_phone",
  "invalid_phone",
  "invalid_email",
  "duplicate_in_file",
  "already_in_campaign",
  "bad_row",
] as const;
export type CampaignImportRejectReason = (typeof CAMPAIGN_IMPORT_REJECT_REASONS)[number];

/** Quem fez o clique (`campaign_clicks.agent_class`). Só `browser` conta como pessoa. */
export const CAMPAIGN_CLICK_AGENT_CLASSES = ["browser", "preview", "bot"] as const;
export type CampaignClickAgentClass = (typeof CAMPAIGN_CLICK_AGENT_CLASSES)[number];
