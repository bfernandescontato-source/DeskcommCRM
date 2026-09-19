/**
 * QUEM FALOU, numa conversa de GRUPO do WhatsApp.
 *
 * A conversa do grupo é uma só (contato-fantasma, migration 0276): o que separa
 * as pessoas é `messages.metadata`, gravado na ingestão —
 * `group_participant` (id do remetente), `group_participant_name` (o nome que
 * ele mesmo usa no WhatsApp, quando informa) e `group_participant_phone`.
 *
 * Como no WhatsApp: o nome, quando existe; senão o telefone; e só como último
 * recurso um rótulo genérico. Nunca o id técnico (`123@lid`), que é lixo na tela.
 */
import { normalizePhoneForDisplay } from "@/lib/messaging/contact-card";

export interface ParticipanteDoGrupo {
  /** Estável por pessoa — é o que dá a MESMA cor a ela em toda a conversa. */
  chave: string;
  /** O que aparece na tela. */
  nome: string;
}

interface MensagemComMetadata {
  direction?: string | null;
  metadata?: Record<string, unknown> | null;
}

const texto = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** `null` quando a mensagem não é de um participante de grupo (ou saiu de nós). */
export function participanteDoGrupo(m: MensagemComMetadata): ParticipanteDoGrupo | null {
  if (m.direction === "outbound") return null;
  const meta = m.metadata;
  if (!meta || meta.is_group !== true) return null;

  const nome = texto(meta.group_participant_name);
  const telefone = texto(meta.group_participant_phone);
  const id = texto(meta.group_participant);

  return {
    chave: id ?? telefone ?? nome ?? "participante",
    nome: nome ?? (telefone ? normalizePhoneForDisplay(telefone) : "Participante"),
  };
}

/**
 * Paleta do WhatsApp para nomes de participante, com variante para o tema
 * escuro. Classes escritas por extenso de propósito: o Tailwind só gera o que
 * consegue ler no fonte.
 */
const CORES = [
  "text-emerald-700 dark:text-emerald-400",
  "text-sky-700 dark:text-sky-400",
  "text-rose-700 dark:text-rose-400",
  "text-amber-700 dark:text-amber-400",
  "text-violet-700 dark:text-violet-400",
  "text-teal-700 dark:text-teal-400",
  "text-orange-700 dark:text-orange-400",
  "text-fuchsia-700 dark:text-fuchsia-400",
] as const;

/** A mesma pessoa, a mesma cor — em qualquer recarga e em qualquer tela. */
export function corDoParticipante(chave: string): string {
  let h = 0;
  for (let i = 0; i < chave.length; i++) h = (h * 31 + chave.charCodeAt(i)) >>> 0;
  return CORES[h % CORES.length] ?? CORES[0];
}
