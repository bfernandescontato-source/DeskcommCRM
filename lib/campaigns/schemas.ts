/**
 * Entradas da API da Central de Disparos. Todo input externo passa por aqui (Zod).
 *
 * `.strict()` de propósito: um campo que o servidor não conhece é recusado, em
 * vez de ignorado em silêncio — o cliente que mandou `organization_id` no corpo
 * descobre na hora que a organização nunca vem do corpo.
 */
import { z } from "zod";

import { CAMPAIGN_CHANNEL_POLICIES } from "./vocabulario";

const nomeDaCampanha = z.string().trim().min(1).max(120);
const uuid = z.string().uuid();

/** Hosts em que um convite de grupo (chat.) ou de canal (whatsapp.com/channel) mora. Qualquer outro é recusado. */
const HOSTS_DE_CONVITE = new Set(["chat.whatsapp.com", "whatsapp.com"]);

/**
 * O link que o redirecionador vai abrir. Só https, só WhatsApp, sem credencial
 * embutida (`https://x@evil`). O redirecionador público (`/g/<token>`) só leva a um
 * destino que uma pessoa autorizada cadastrou — e esta é a régua dela.
 */
export function conviteValido(bruto: string): boolean {
  if (bruto.length > 2048 || /\s/.test(bruto)) return false;
  try {
    const u = new URL(bruto);
    return (
      u.protocol === "https:" &&
      HOSTS_DE_CONVITE.has(u.hostname.toLowerCase()) &&
      u.username === "" &&
      u.password === "" &&
      u.pathname.length > 1
    );
  } catch {
    return false;
  }
}

const convite = z
  .string()
  .trim()
  .refine(conviteValido, { message: "Use o link de convite do WhatsApp (https://chat.whatsapp.com/…)." });

export const criarCampanhaSchema = z
  .object({
    name: nomeDaCampanha,
    tracking_enabled: z.boolean().default(true),
    channel_policy: z.enum(CAMPAIGN_CHANNEL_POLICIES).default("skip_channel"),
  })
  .strict();

export const atualizarCampanhaSchema = z
  .object({
    name: nomeDaCampanha.optional(),
    tracking_enabled: z.boolean().optional(),
    channel_policy: z.enum(CAMPAIGN_CHANNEL_POLICIES).optional(),
    /** Intervalo FIXO entre dois envios do mesmo número, em segundos. */
    send_interval_seconds: z.number().int().min(10).max(3600).optional(),
    /** Teto da campanha por número por dia; `null` volta ao teto do próprio número. */
    daily_cap_per_channel: z.number().int().min(1).max(5000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Informe ao menos um campo." });

/** As ações que uma PESSOA pode pedir. `fail` é do sistema (worker) e não passa pela API. */
export const ACOES_DA_API = ["ready", "start", "pause", "resume", "complete", "cancel"] as const;
export type AcaoDaApi = (typeof ACOES_DA_API)[number];

export const transicaoSchema = z
  .object({
    action: z.enum(ACOES_DA_API),
    reason: z.string().trim().max(120).optional(),
  })
  .strict();

export const canaisSchema = z.object({ channel_ids: z.array(uuid).max(50) }).strict();

export const versaoSchema = z
  .object({
    body: z.string().trim().min(1).max(4096),
    /** "Aplicar esta nova versão aos próximos contatos da fila?" — false guarda sem usar. */
    activate: z.boolean().default(true),
    /** A última versão que a tela viu; se mudou, o servidor recusa em vez de sobrescrever. */
    based_on_version_no: z.number().int().min(0).optional(),
  })
  .strict();

const grupoDoWhatsapp = z.string().regex(/^[0-9-]+@g\.us$/, "Formato esperado: 1203…@g.us");

export const destinoSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    invite_url: convite,
    group_chat_id: grupoDoWhatsapp.nullish(),
    capacity: z.number().int().min(1).max(100_000).nullish(),
    activate: z.boolean().default(false),
    /** O destino que a tela achava ser o ativo; se outra pessoa já trocou, o servidor recusa. */
    expected_current: uuid.nullish(),
    close_reason: z.enum(["full", "manual"]).default("full"),
  })
  .strict();

export const ativarDestinoSchema = z
  .object({
    expected_current: uuid.nullish(),
    close_reason: z.enum(["full", "manual"]).default("full"),
  })
  .strict();

/** Paginação da lista de eventos: cursor opaco, limite pequeno. */
export const eventosQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  contact: uuid.optional(),
});

export type CriarCampanhaInput = z.infer<typeof criarCampanhaSchema>;
export type AtualizarCampanhaInput = z.infer<typeof atualizarCampanhaSchema>;
export type VersaoInput = z.infer<typeof versaoSchema>;
export type DestinoInput = z.infer<typeof destinoSchema>;

/** O mapeamento de colunas que o operador confirma na prévia. Índices contam a partir de 0. */
export const mapeamentoSchema = z
  .object({
    phone: z.number().int().min(0).max(199),
    name: z.number().int().min(0).max(199).nullable().default(null),
    email: z.number().int().min(0).max(199).nullable().default(null),
    extras: z
      .array(z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), index: z.number().int().min(0).max(199) }).strict())
      .max(30)
      .default([]),
  })
  .strict();

export const rejeitadosQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  format: z.enum(["json", "csv"]).default("json"),
});
