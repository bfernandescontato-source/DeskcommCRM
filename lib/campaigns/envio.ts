/**
 * O ENVIO DE UM CONTATO DA CAMPANHA — a ponte entre a fila e o caminho de saída do CRM.
 *
 * Não existe um segundo caminho de envio: a mensagem sai por `sendMessageHandler`, o mesmo
 * que o Inbox, a automação e o agente usam. Isso é o que faz a resposta da pessoa cair na
 * caixa de atendimento que já existe (mesma conversa, mesmo contato) em vez de numa
 * segunda caixa.
 *
 * ─── A conversa que a campanha cria fica ESCONDIDA até a pessoa responder ─────
 * 45 mil envios criariam 45 mil conversas. A conversa nova nasce marcada
 * `metadata.campaign.hidden_until_reply`; quem responde a "acorda" (a marca é retirada
 * quando chega a primeira mensagem dela) e só então aparece na lista. Uma conversa que
 * já existia — o cliente que já conversava com o atendente — NUNCA é escondida.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ensureConversation } from "@/lib/automation/start-conversation";

export interface EnvioDeTexto {
  orgId: string;
  contactId: string;
  channelId: string;
  campaignId: string;
  campaignContactId: string;
  texto: string;
}

export interface ResultadoDoEnvio {
  messageId: string;
  externalId: string | null;
  /** `sent` saiu; `failed` o canal recusou (definitivo); `queued` o número não estava pronto e nada saiu. */
  status: "sent" | "failed" | "queued";
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * O link que vai no lugar de `{{link_grupo}}`: o rastreável (`<base>/g/<token>`) quando o
 * rastreio está ligado e há base pública; senão o convite cru. Sem destino: nada.
 */
export function linkDoGrupo(o: { trackingEnabled: boolean; token: string; destinationUrl: string | null; baseUrl: string | null }): string | null {
  if (!o.destinationUrl) return null;
  if (o.trackingEnabled && o.baseUrl && o.token) return `${o.baseUrl.replace(/\/+$/, "")}/g/${o.token}`;
  return o.destinationUrl;
}

const ENVIADA = new Set(["sent", "delivered", "read"]);

export function enviarTextoPelaCentral(admin: SupabaseClient): (envio: EnvioDeTexto) => Promise<ResultadoDoEnvio> {
  return async (e) => {
    const conversaId = await ensureConversation(admin, e.orgId, e.contactId, e.channelId);

    // Só esconde a conversa que a CAMPANHA acabou de criar: sem nenhuma mensagem antes.
    const { data: antes } = await admin
      .from("conversations")
      .select("last_message_at, metadata")
      .eq("id", conversaId)
      .eq("organization_id", e.orgId)
      .maybeSingle();
    const conversa = antes as { last_message_at: string | null; metadata: Record<string, unknown> | null } | null;
    if (conversa && conversa.last_message_at === null) {
      await admin
        .from("conversations")
        .update({ metadata: { ...(conversa.metadata ?? {}), campaign: { id: e.campaignId, hidden_until_reply: true } } })
        .eq("id", conversaId)
        .eq("organization_id", e.orgId);
    }

    const msg = await sendMessageHandler(
      admin,
      {
        organization_id: e.orgId,
        // `webhook_source` é o ator que esta base dá a envio nascido de worker; o id é a
        // linha da campanha, para a auditoria da mensagem apontar de onde ela veio.
        actor: { type: "webhook_source", id: e.campaignContactId },
        requestId: `campaign:${e.campaignContactId}`,
      },
      { conversation_id: conversaId, type: "text", body: e.texto } as Parameters<typeof sendMessageHandler>[2],
    );

    if (ENVIADA.has(msg.status)) {
      return { messageId: msg.id, externalId: msg.external_id ?? null, status: "sent" };
    }
    if (msg.status === "queued") {
      // Nada saiu e ninguém vai enviar essa linha depois: marca falha para ela não ficar
      // pendurada na conversa como se fosse sair. A campanha tenta de novo, com outra mensagem.
      await admin
        .from("messages")
        .update({ status: "failed", error_code: "campaign_not_sent", error_message: "O número não estava pronto; a campanha vai tentar de novo." })
        .eq("id", msg.id)
        .eq("organization_id", e.orgId);
      return { messageId: msg.id, externalId: null, status: "queued" };
    }
    return { messageId: msg.id, externalId: null, status: "failed", errorCode: msg.error_code, errorMessage: msg.error_message };
  };
}
