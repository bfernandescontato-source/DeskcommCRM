"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Alerta } from "@/lib/campaigns/alertas";
import type { Agora, LinhaDaFila, MetricasDaCampanha, PainelGeral, PerfilDoContato } from "@/lib/campaigns/leituras";
import type { AcaoDaApi, AtualizarCampanhaInput, DestinoInput, VersaoInput } from "@/lib/campaigns/schemas";
import type { ResumoDaImportacao, ProgressoDaImportacao } from "@/lib/campaigns/importacao-service";
import type { CampanhaDetalhada, CampanhaResumo, ResultadoDeDestino, ResultadoDeTransicao, ResultadoDeVersao } from "@/lib/campaigns/service";
import type { EventoLinha, VersaoLinha } from "@/lib/campaigns/tipos";

import { chamar, queryDaFila } from "./api";

/**
 * Leituras e ações da Central de Disparos.
 *
 * A tela NUNCA guarda o estado de uma campanha: tudo vem do servidor e volta a ele. Por isso
 * atualizar é `refetchInterval` (só com a aba visível) e toda ação invalida as chaves da
 * campanha — abrir a mesma campanha em duas abas mostra o mesmo, e recarregar a página não
 * perde nada.
 */
const RAIZ = ["campanhas"] as const;
export const chaves = {
  painel: [...RAIZ, "painel"] as const,
  campanha: (id: string) => [...RAIZ, id] as const,
  visao: (id: string) => [...RAIZ, id, "visao"] as const,
  fila: (id: string, qs: string) => [...RAIZ, id, "fila", qs] as const,
  contato: (id: string, cc: string) => [...RAIZ, id, "contato", cc] as const,
  atividade: (id: string) => [...RAIZ, id, "atividade"] as const,
  importacao: (id: string, importId: string) => [...RAIZ, id, "importacao", importId] as const,
};

/** Com a campanha rodando, o número muda a cada minuto; parada, só quando alguém mexe. */
const A_CADA = 5_000;

// ── leituras ────────────────────────────────────────────────────────────────

export interface PainelDaCentral {
  panel: PainelGeral;
  campaigns: CampanhaResumo[];
  alerts: Array<{ campaign_id: string; campaign_name: string; alerts: Alerta[] }>;
}

export function usePainel() {
  return useQuery({
    queryKey: chaves.painel,
    queryFn: async () => (await chamar<PainelDaCentral>("/dashboard")).data,
    refetchInterval: A_CADA,
    refetchIntervalInBackground: false,
    staleTime: 2_000,
  });
}

export interface VisaoGeral extends Omit<CampanhaDetalhada, "versions"> {
  versions: Array<VersaoLinha & { created_by_name: string | null }>;
  metrics: MetricasDaCampanha;
  now: Agora;
  alerts: Alerta[];
}

export function useVisaoGeral(id: string) {
  return useQuery({
    queryKey: chaves.visao(id),
    // O assistente ainda não tem campanha na primeira tela (só o nome): sem id, não pergunta nada ao servidor.
    enabled: id !== "",
    queryFn: async () => (await chamar<VisaoGeral>(`/${id}/overview`)).data,
    refetchInterval: A_CADA,
    refetchIntervalInBackground: false,
    staleTime: 2_000,
  });
}

export interface FiltrosDaFilaUi {
  status?: string[];
  channel?: string;
  destination?: string;
  version?: string;
  clicked?: boolean;
  replied?: boolean;
  q?: string;
}

/** A Fila, em páginas por cursor: 50 por vez, "carregar mais" pede a próxima a partir do último. */
export function useFila(id: string, filtros: FiltrosDaFilaUi) {
  const base = queryDaFila(filtros);
  return useInfiniteQuery({
    queryKey: chaves.fila(id, base),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const r = await chamar<LinhaDaFila[]>(`/${id}/contacts?${queryDaFila({ ...filtros, after: pageParam, limit: 50 })}`);
      return { linhas: r.data, proximo: r.meta?.cursor ? Number(r.meta.cursor) : null };
    },
    getNextPageParam: (ultima) => ultima.proximo ?? undefined,
    refetchInterval: A_CADA * 2,
    refetchIntervalInBackground: false,
  });
}

export function usePerfilDoContato(id: string, contatoId: string | null) {
  return useQuery({
    queryKey: chaves.contato(id, contatoId ?? "-"),
    enabled: contatoId !== null,
    queryFn: async () => (await chamar<PerfilDoContato>(`/${id}/contacts/${contatoId}`)).data,
  });
}

export interface EventoComAutor extends EventoLinha {
  actor_name?: string | null;
}

/** A aba Atividade. `incluirEnvios` traz também o que aconteceu com cada contato (envio, clique…); por padrão, só a campanha. */
export function useAtividade(id: string, incluirEnvios = false) {
  return useInfiniteQuery({
    queryKey: [...chaves.atividade(id), incluirEnvios ? "tudo" : "campanha"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const r = await chamar<EventoComAutor[]>(`/${id}/events?limit=30&scope=${incluirEnvios ? "all" : "campaign"}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`);
      return { eventos: r.data, proximo: r.meta?.cursor ?? null };
    },
    getNextPageParam: (ultima) => ultima.proximo ?? undefined,
    refetchInterval: A_CADA * 2,
    refetchIntervalInBackground: false,
  });
}

/** Onde a importação está. Com o arquivo enviado e ainda não mapeado, traz também a prévia e o mapeamento sugerido. */
export type EstadoDaImportacao = ResumoDaImportacao & { sample?: string[][]; suggested_mapping?: MapeamentoSugerido };

export function useImportacao(id: string, importId: string | null) {
  return useQuery({
    queryKey: chaves.importacao(id, importId ?? "-"),
    enabled: importId !== null,
    queryFn: async () => (await chamar<EstadoDaImportacao>(`/${id}/imports/${importId}`)).data,
  });
}

// ── ações ───────────────────────────────────────────────────────────────────

function useInvalidar(id?: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: id ? chaves.campanha(id) : RAIZ }), qc.invalidateQueries({ queryKey: chaves.painel })]);
}

export function useCriarCampanha() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: async (v: { name: string; tracking_enabled?: boolean }) => (await chamar<{ id: string }>("", { method: "POST", json: v })).data,
    onSuccess: invalidar,
  });
}

export function useTransicao(id: string) {
  const invalidar = useInvalidar(id);
  return useMutation({
    mutationFn: async (v: { action: AcaoDaApi; reason?: string }) => (await chamar<ResultadoDeTransicao>(`/${id}/transition`, { method: "POST", json: v })).data,
    onSuccess: invalidar,
  });
}

export function useAtualizarCampanha(id: string) {
  const invalidar = useInvalidar(id);
  return useMutation({
    mutationFn: async (v: AtualizarCampanhaInput) => (await chamar<{ changed: boolean }>(`/${id}`, { method: "PATCH", json: v })).data,
    onSuccess: invalidar,
  });
}

export function useDefinirCanais(id: string) {
  const invalidar = useInvalidar(id);
  return useMutation({
    mutationFn: async (channel_ids: string[]) => (await chamar<{ added: number; removed: number }>(`/${id}/channels`, { method: "PUT", json: { channel_ids } })).data,
    onSuccess: invalidar,
  });
}

export function useCriarVersao(id: string) {
  const invalidar = useInvalidar(id);
  return useMutation({
    mutationFn: async (v: Pick<VersaoInput, "body" | "activate" | "based_on_version_no">) => (await chamar<ResultadoDeVersao>(`/${id}/versions`, { method: "POST", json: v })).data,
    onSuccess: invalidar,
  });
}

export function useCadastrarDestino(id: string) {
  const invalidar = useInvalidar(id);
  return useMutation({
    mutationFn: async (v: Partial<DestinoInput> & Pick<DestinoInput, "name" | "invite_url">) => (await chamar<ResultadoDeDestino>(`/${id}/destinations`, { method: "POST", json: v })).data,
    onSuccess: invalidar,
  });
}

export function useAtivarDestino(id: string) {
  const invalidar = useInvalidar(id);
  return useMutation({
    mutationFn: async (v: { destinationId: string; expected_current?: string | null; close_reason?: "full" | "manual" }) =>
      (await chamar<{ changed: boolean }>(`/${id}/destinations/${v.destinationId}/activate`, { method: "POST", json: { expected_current: v.expected_current ?? null, close_reason: v.close_reason ?? "full" } })).data,
    onSuccess: invalidar,
  });
}

export function useResolverIncerto(id: string) {
  const invalidar = useInvalidar(id);
  return useMutation({
    mutationFn: async (v: { contactId: string; resolution: "sent" | "retry" | "failed" }) =>
      (await chamar<{ result: string }>(`/${id}/contacts/${v.contactId}/resolve`, { method: "POST", json: { resolution: v.resolution } })).data,
    onSuccess: invalidar,
  });
}

// ── importação: cada passo é uma chamada curta; o servidor guarda o estado ──

export interface MapeamentoSugerido {
  phone: number | null;
  name: number | null;
  email: number | null;
  extras: Array<{ key: string; index: number; label: string }>;
}

export interface PrevaDoCsv {
  import_id: string;
  filename: string;
  total_rows: number;
  headers: string[];
  sample: string[][];
  suggested_mapping: MapeamentoSugerido;
}

/** O que o servidor recebe ao validar: índices das colunas escolhidas. */
export interface MapeamentoEscolhido {
  phone: number;
  name: number | null;
  email: number | null;
  extras: Array<{ key: string; index: number }>;
}

export const enviarCsv = async (id: string, arquivo: File): Promise<PrevaDoCsv> => {
  const form = new FormData();
  form.append("file", arquivo);
  return (await chamar<PrevaDoCsv>(`/${id}/imports`, { method: "POST", body: form })).data;
};

export const validarCsv = async (id: string, importId: string, mapeamento: MapeamentoEscolhido) =>
  (await chamar<ResumoDaImportacao>(`/${id}/imports/${importId}/validate`, { method: "POST", json: mapeamento })).data;

/** Um passo da importação; a tela repete até `remaining === 0` (é a barra de progresso). */
export const importarLote = async (id: string, importId: string) =>
  (await chamar<ProgressoDaImportacao>(`/${id}/imports/${importId}/commit`, { method: "POST" })).data;

export const descartarCsv = async (id: string, importId: string) =>
  (await chamar<{ changed: boolean }>(`/${id}/imports/${importId}`, { method: "DELETE" })).data;

export const urlDosRejeitados = (id: string, importId: string) => `/api/v1/campaigns/${id}/imports/${importId}/rejects?format=csv`;
