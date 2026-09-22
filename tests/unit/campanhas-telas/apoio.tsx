import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

export const ORG = "b7c30000-0000-4000-8000-000000000001";
export const C1 = "c1000000-0000-4000-8000-000000000001";
export const C2 = "c2000000-0000-4000-8000-000000000002";
export const C3 = "c3000000-0000-4000-8000-000000000003";

export interface Chamada {
  metodo: string;
  caminho: string;
  /** A query string, já decodificada em pares. */
  consulta: URLSearchParams;
  corpo: unknown;
}

type Resposta = { status?: number; corpo: unknown };
type Rota = Resposta | ((c: Chamada) => Resposta);

/**
 * Um servidor de mentira: responde por "MÉTODO /caminho" (sem a query string) e guarda o que foi
 * chamado. Rota não prevista é um erro do teste — não devolve nada em silêncio.
 */
export function servidor(rotas: Record<string, Rota>) {
  const chamadas: Chamada[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = (init?.method ?? "GET").toUpperCase();
    const caminho = url.split("?")[0]!;
    let corpo: unknown = undefined;
    if (typeof init?.body === "string") corpo = JSON.parse(init.body);
    else if (init?.body instanceof FormData) corpo = { arquivo: (init.body.get("file") as File | null)?.name };
    const chamada = { metodo, caminho, corpo, consulta: new URLSearchParams(url.split("?")[1] ?? "") };
    chamadas.push(chamada);
    const rota = rotas[`${metodo} ${caminho}`];
    if (!rota) throw new Error(`Rota não prevista no teste: ${metodo} ${url}`);
    const r = typeof rota === "function" ? rota(chamada) : rota;
    return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", f);
  return { chamadas, f, feitas: (metodo: string, caminho: string) => chamadas.filter((c) => c.metodo === metodo && c.caminho === caminho) };
}

export function renderizar(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

export const CONTAGENS = { total: 45000, pending: 36000, queued: 0, processing: 1, sent: 8420, failed: 3, uncertain: 0, skipped: 0, cancelled: 0, clicked: 2184, replied: 91, joined: 0, left: 0 };

export function campanha(id: string, nome: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    name: nome,
    status,
    status_reason: null,
    active_version_id: "v2",
    active_destination_id: "d4",
    tracking_enabled: true,
    channel_policy: "skip_channel",
    send_interval_seconds: 180,
    daily_cap_per_channel: null,
    revision: 3,
    started_at: "2026-09-21T12:00:00Z",
    paused_at: null,
    finished_at: null,
    created_by: null,
    created_at: "2026-09-20T12:00:00Z",
    updated_at: "2026-09-21T12:00:00Z",
    counts: { ...CONTAGENS },
    ...extra,
  };
}

export const PAINEL = {
  panel: { running: 2, paused: 1, sent_today: 1234, active: { pending: 36580, sent: 8420, failed: 3, clicked: 2184, replied: 91, joined: 0, left: 0 } },
  campaigns: [campanha(C1, "BLACK Friday", "running"), campanha(C2, "Campanha pausada", "paused", { status_reason: "channel_down" }), campanha(C3, "Meu rascunho", "draft", { counts: { ...CONTAGENS, total: 0, sent: 0 } })],
  alerts: [
    {
      campaign_id: C1,
      campaign_name: "BLACK Friday",
      alerts: [{ level: "warning", code: "capacity_near", message: "BLACK #04 está com 92% da capacidade.", action: "switch_destination", subject: "BLACK #04" }],
    },
  ],
};

export const PODE_TUDO = { ver: true, criar: true, editar: true, pausar: true, iniciar: true, encerrar: true, resolverIncerto: true };
export const PODE_GERENTE = { ...PODE_TUDO, iniciar: false, encerrar: false };

/** A Visão geral de uma campanha rodando, com duas versões, dois grupos e dois números. */
export function visao(extra: Record<string, unknown> = {}) {
  const c = campanha(C1, "BLACK Friday", "running");
  const { counts, ...campaign } = c;
  return {
    campaign,
    counts,
    versions: [
      { id: "v2", version_no: 2, body: "Oi {{primeiro_nome}}! Entre no grupo: {{link_grupo}}", created_by: "u1", created_by_name: "Bruno", created_at: "2026-09-21T13:00:00Z", activated_at: "2026-09-21T13:00:00Z", superseded_at: null },
      { id: "v1", version_no: 1, body: "Oi {{nome}}, entre: {{link_grupo}}", created_by: "u1", created_by_name: "Bruno", created_at: "2026-09-21T12:00:00Z", activated_at: "2026-09-21T12:00:00Z", superseded_at: "2026-09-21T13:00:00Z" },
    ],
    destinations: [
      { id: "d3", sequence_no: 3, name: "BLACK #03", invite_url: "https://chat.whatsapp.com/AAA", group_chat_id: null, capacity: 1000, status: "closed", opened_at: "2026-09-21T12:00:00Z", closed_at: "2026-09-21T14:00:00Z", close_reason: "full", created_at: "2026-09-21T11:00:00Z" },
      { id: "d4", sequence_no: 4, name: "BLACK #04", invite_url: "https://chat.whatsapp.com/BBB", group_chat_id: null, capacity: 1000, status: "active", opened_at: "2026-09-21T14:00:00Z", closed_at: null, close_reason: null, created_at: "2026-09-21T11:00:00Z" },
      { id: "d5", sequence_no: 5, name: "BLACK #05", invite_url: "https://chat.whatsapp.com/CCC", group_chat_id: null, capacity: 1000, status: "queued", opened_at: null, closed_at: null, close_reason: null, created_at: "2026-09-21T11:00:00Z" },
    ],
    channels: [
      { channel_session_id: "s1", enabled: true, session: { id: "s1", display_name: "Número 01", phone_number: "5511999990001", status: "WORKING" } },
      { channel_session_id: "s2", enabled: true, session: { id: "s2", display_name: "Número 02", phone_number: "5511999990002", status: "WORKING" } },
    ],
    metrics: {
      by_version: [
        { version_no: 1, version_id: "v1", sent: 5000, clicked: 1000, replied: 40, failed: 1 },
        { version_no: 2, version_id: "v2", sent: 3420, clicked: 1184, replied: 51, failed: 2 },
      ],
      by_destination: [
        { destination_id: "d3", sequence_no: 3, name: "BLACK #03", status: "closed", capacity: 1000, opened_at: null, closed_at: null, close_reason: "full", directed: 1000, clicked: 700, joined: 0, left: 0, clicks_raw: 700, members: 0, members_left: 0, joined_total: 0 },
        { destination_id: "d4", sequence_no: 4, name: "BLACK #04", status: "active", capacity: 1000, opened_at: null, closed_at: null, close_reason: null, directed: 920, clicked: 800, joined: 0, left: 0, clicks_raw: 800, members: 0, members_left: 0, joined_total: 0 },
      ],
      by_channel: [],
    },
    now: {
      status: "running",
      status_reason: null,
      last_sent: { at: new Date().toISOString(), contact: "Maria Silva", phone: "+55 11 99999-0000", channel: "Número 01" },
      in_flight: { contact: "João", channel: "Número 02" },
      remaining: 36580,
      current_destination: "BLACK #04",
      channels: [
        { id: "s1", label: "Número 01", status: "WORKING", sent: 4200, failed: 1, last_sent_at: new Date().toISOString(), can_send_now: true, next_at: null, blocked_by: null },
        { id: "s2", label: "Número 02", status: "WORKING", sent: 4220, failed: 2, last_sent_at: new Date().toISOString(), can_send_now: false, next_at: "2026-09-21T15:00:00Z", blocked_by: "interval" },
      ],
      next_at: null,
    },
    alerts: [],
    ...extra,
  };
}

export function linhaDaFila(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    seq: 1,
    status: "sent",
    skip_reason: null,
    contact_id: `contact-${id}`,
    name: "Maria Silva",
    phone: "+55 11 99999-0001",
    channel: "Número 01",
    version_no: 2,
    destination: "BLACK #04",
    sent_at: "2026-09-21T15:04:00Z",
    updated_at: "2026-09-21T15:04:00Z",
    attempts: 1,
    last_error_code: null,
    clicked_at: null,
    replied_at: null,
    joined_at: null,
    left_at: null,
    ...extra,
  };
}

export function perfil(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    campaign_id: C1,
    state: "CLICOU",
    status: "sent",
    contact: { id: "contact-1", name: "Maria Silva", phone: "+55 11 99999-0001" },
    channel: "Número 01",
    version_no: 2,
    destination: "BLACK #04",
    attempts: 1,
    last_error_code: null,
    last_error: null,
    variables: { cidade: "Campinas" },
    imported_at: "2026-09-20T12:00:00Z",
    import_filename: "lista-black.csv",
    sent_at: "2026-09-21T15:04:00Z",
    clicked_at: "2026-09-21T15:10:00Z",
    replied_at: null,
    joined_at: null,
    left_at: null,
    message: { id: "m1", body: "Oi Maria! Entre no grupo: https://app.exemplo.com/g/abcdef0123456789abcd", conversation_id: "conv-1", status: "sent" },
    events: [
      { id: "e1", campaign_contact_id: id, kind: "sent", occurred_at: "2026-09-21T15:04:00Z", actor_user_id: null, actor_name: null, message_version_id: "v2", destination_id: "d4", channel_session_id: "s1", payload: {} },
      { id: "e2", campaign_contact_id: id, kind: "clicked", occurred_at: "2026-09-21T15:10:00Z", actor_user_id: null, actor_name: null, message_version_id: null, destination_id: "d4", channel_session_id: null, payload: {} },
    ],
    ...extra,
  };
}
