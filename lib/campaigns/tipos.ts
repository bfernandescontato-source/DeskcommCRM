/**
 * Formatos das linhas da Central de Disparos, como o PostgREST as devolve.
 *
 * Existem aqui porque `lib/database.types.ts` (gerado do banco) ainda não conhece
 * as tabelas da migration 0280. Quando ele for regenerado, estes tipos passam a
 * poder derivar de lá — e o vocabulário (status, kinds) já vem de `./vocabulario`.
 */
import type {
  CampaignChannelPolicy,
  CampaignDestinationCloseReason,
  CampaignDestinationStatus,
  CampaignEventKind,
  CampaignStatus,
} from "./vocabulario";

export interface CampanhaLinha {
  id: string;
  organization_id: string;
  name: string;
  status: CampaignStatus;
  status_reason: string | null;
  active_version_id: string | null;
  active_destination_id: string | null;
  tracking_enabled: boolean;
  channel_policy: CampaignChannelPolicy;
  send_interval_seconds: number;
  daily_cap_per_channel: number | null;
  revision: number;
  started_at: string | null;
  paused_at: string | null;
  finished_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersaoLinha {
  id: string;
  version_no: number;
  body: string;
  created_by: string | null;
  created_at: string;
  activated_at: string | null;
  superseded_at: string | null;
}

export interface DestinoLinha {
  id: string;
  sequence_no: number;
  name: string;
  invite_url: string;
  group_chat_id: string | null;
  capacity: number | null;
  status: CampaignDestinationStatus;
  opened_at: string | null;
  closed_at: string | null;
  close_reason: CampaignDestinationCloseReason | null;
  created_at: string;
}

export interface CanalDaCampanha {
  channel_session_id: string;
  enabled: boolean;
  session: {
    id: string;
    display_name: string | null;
    phone_number: string | null;
    status: string;
  } | null;
}

/** Placar direto da fonte (`fn_campaign_counts`): nunca de contador agregado. */
export interface Contagens {
  total: number;
  pending: number;
  queued: number;
  processing: number;
  sent: number;
  failed: number;
  uncertain: number;
  skipped: number;
  cancelled: number;
  clicked: number;
  replied: number;
  joined: number;
  left: number;
}

export interface EventoLinha {
  id: string;
  campaign_contact_id: string | null;
  kind: CampaignEventKind;
  occurred_at: string;
  actor_user_id: string | null;
  message_version_id: string | null;
  destination_id: string | null;
  channel_session_id: string | null;
  payload: Record<string, unknown>;
}
