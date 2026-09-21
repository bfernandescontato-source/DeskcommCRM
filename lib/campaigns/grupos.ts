/**
 * ENTRADAS E SAÍDAS DE GRUPO — do aviso do WhatsApp (WAHA) para o banco.
 *
 * O CRM só sabe que alguém entrou ou saiu de um grupo porque o WhatsApp AVISOU. Este arquivo
 * lê o aviso e o entrega a `fn_campaign_record_group_event` (migration 0286), que decide a que
 * campanha e a que contato ele pertence — só por telefone ou por LID, só entre contatos já
 * enviados. Aqui não se atribui nada e nunca se infere: clique não é entrada.
 *
 * ─── O formato do aviso NÃO foi verificado contra o WAHA real ───────────────────
 * O evento é `group.v2.participants` com `payload = { group: { id }, type, timestamp,
 * participants: [{ id } | "id"] }` na documentação do WAHA. A leitura abaixo aceita essa forma
 * e as variações plausíveis (`groupId`, `action`, participante como texto ou objeto com
 * `id`/`jid`/`lid`/`phoneNumber`/`pn`); o que não reconhece, ignora — nunca lança. Na
 * implantação, um teste com um número de teste (entrar e sair de um grupo-destino) confirma o
 * formato de verdade antes de qualquer campanha depender disso.
 *
 * ─── Nunca derruba a ingestão de mensagens ──────────────────────────────────────
 * `registrarAvisoDeGrupo` engole qualquer erro e o registra sem dado pessoal: uma falha aqui não
 * pode atrasar nem perder uma mensagem recebida, que passa pelo mesmo roteador.
 */
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { logger } from "@/lib/logger";

export interface AvisoDeGrupo {
  grupo: string;
  tipo: "join" | "leave";
  /** Referência estável do participante (`tel:<dígitos>` ou `lid:<id>`): serve para contar pessoas distintas. */
  participante: string;
  telefones: string[];
  lid: string | null;
  quando: Date;
}

const ENTRADA = new Set(["join", "joined", "add", "added", "invite", "invited"]);
const SAIDA = new Set(["leave", "left", "remove", "removed", "kick", "kicked"]);
/** O aviso pode chegar de um ponto passado (reconexão); mais que isto no futuro é relógio errado. */
const TOLERANCIA_DO_FUTURO_MS = 24 * 60 * 60 * 1000;

const ehTexto = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const objeto = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function grupoDoPayload(p: Record<string, unknown>): string | null {
  const candidatos = [objeto(p.group)?.id, p.groupId, p.chatId, p.id];
  return candidatos.find((c): c is string => ehTexto(c) && c.endsWith("@g.us"))?.trim() ?? null;
}

function quandoDoAviso(p: Record<string, unknown>, agora: Date): Date {
  const t = typeof p.timestamp === "number" ? p.timestamp : typeof p.timestamp === "string" ? Number(p.timestamp) : NaN;
  if (!Number.isFinite(t) || t <= 0) return agora;
  // Segundos (10 dígitos) ou milissegundos (13).
  const ms = t < 1e12 ? t * 1000 : t;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) || d.getTime() > agora.getTime() + TOLERANCIA_DO_FUTURO_MS ? agora : d;
}

/** Um participante -> telefone(s) e LID que o identificam. `null` quando não há como identificá-lo. */
function participanteDe(item: unknown): { telefones: string[]; lid: string | null; ref: string } | null {
  const ids: string[] = [];
  const o = objeto(item);
  if (ehTexto(item)) ids.push(item.trim());
  if (o) for (const k of ["id", "jid", "participant", "lid", "phoneNumber", "pn", "phone"]) if (ehTexto(o[k])) ids.push((o[k] as string).trim());
  if (ids.length === 0) return null;

  let lid: string | null = null;
  const digitos = new Set<string>();
  for (const id of ids) {
    if (id.endsWith("@lid")) lid ??= id.slice(0, -"@lid".length);
    else if (id.endsWith("@c.us") || id.endsWith("@s.whatsapp.net")) digitos.add(id.split("@")[0]!.replace(/\D/g, ""));
    else if (/^\+?\d{8,15}$/.test(id)) digitos.add(id.replace(/\D/g, ""));
  }
  const telefones = [...digitos].filter(Boolean).flatMap((d) => phoneLookupVariants(d));
  const primeiro = [...digitos].find(Boolean);
  const ref = primeiro ? `tel:${primeiro}` : lid ? `lid:${lid}` : ids[0]!;
  return { telefones: [...new Set(telefones)], lid, ref };
}

/**
 * Os avisos que um evento do WAHA carrega: um por participante. Só `group.v2.participants`
 * (entrada/saída de OUTRAS pessoas); os eventos `group.v2.join`/`leave` são do próprio número
 * entrando/saindo e `group.v2.update` muda nome/descrição — nenhum diz nada da campanha.
 */
export function extrairAvisosDeGrupo(evento: string, payload: Record<string, unknown> | null | undefined, agora = new Date()): AvisoDeGrupo[] {
  if (evento !== "group.v2.participants" || !payload) return [];
  const grupo = grupoDoPayload(payload);
  const bruto = String(payload.type ?? payload.action ?? "").toLowerCase();
  const tipo = ENTRADA.has(bruto) ? "join" : SAIDA.has(bruto) ? "leave" : null;
  if (!grupo || !tipo || !Array.isArray(payload.participants)) return [];
  const quando = quandoDoAviso(payload, agora);
  const avisos: AvisoDeGrupo[] = [];
  for (const item of payload.participants.slice(0, 500)) {
    const p = participanteDe(item);
    if (p) avisos.push({ grupo, tipo, participante: p.ref, telefones: p.telefones, lid: p.lid, quando });
  }
  return avisos;
}

/** O mínimo de um client Supabase que a função usa (o tipo gerado ainda não conhece `fn_campaign_*`). */
export interface ClienteRpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface ResultadoDosAvisos {
  avisos: number;
  registrados: number;
  atribuidos: number;
  erros: number;
}

export async function registrarAvisoDeGrupo(
  admin: ClienteRpc,
  sessao: { id: string; organization_id: string },
  evento: string,
  payload: Record<string, unknown> | null | undefined,
  agora = new Date(),
): Promise<ResultadoDosAvisos> {
  const r: ResultadoDosAvisos = { avisos: 0, registrados: 0, atribuidos: 0, erros: 0 };
  try {
    const avisos = extrairAvisosDeGrupo(evento, payload, agora);
    r.avisos = avisos.length;
    for (const a of avisos) {
      const { data, error } = await admin.rpc("fn_campaign_record_group_event", {
        p_org: sessao.organization_id,
        p_session: sessao.id,
        p_group_chat_id: a.grupo,
        p_kind: a.tipo,
        p_participant_ref: a.participante,
        p_phone_variants: a.telefones,
        p_lid: a.lid,
        p_occurred_at: a.quando.toISOString(),
      });
      if (error) {
        r.erros++;
        // Sem telefone, sem LID e sem nome do grupo no log: só o que ajuda a diagnosticar.
        logger.warn("[campanhas] aviso de grupo não registrado", { erro: error.message, tipo: a.tipo });
        continue;
      }
      const j = (data ?? {}) as { recorded?: number; attributed?: number };
      r.registrados += j.recorded ?? 0;
      r.atribuidos += j.attributed ?? 0;
    }
  } catch (e) {
    r.erros++;
    logger.warn("[campanhas] aviso de grupo: falha inesperada", { erro: e instanceof Error ? e.message : String(e) });
  }
  return r;
}
