/**
 * O ENVIO DE UM CONTATO DA CAMPANHA — a ponte entre a fila e o caminho de saída do CRM.
 *
 * Não existe um segundo caminho de envio: a mensagem sai por `sendMessageHandler`, o mesmo
 * que o Inbox, a automação e o agente usam. Isso é o que faz a resposta da pessoa cair na
 * caixa de atendimento que já existe (mesma conversa, mesmo contato) em vez de numa
 * segunda caixa.
 *
 * ─── A conversa da campanha NÃO ocupa o atendimento ───────────────────────────
 * 45 mil envios criariam 45 mil conversas abertas: cada uma seria roteada a um atendente e
 * entraria na fila. Por isso a conversa é aberta por `fn_campaign_open_conversation`, e não
 * por `ensureConversation` (que reabriria até a conversa fechada de quem já foi cliente):
 *
 *   - conversa NOVA nasce `archived` — fora da lista de trabalho, do roteamento e da fila;
 *     quando a pessoa RESPONDE, o mecanismo que o CRM já tem a reabre e a roteia;
 *   - conversa que JÁ EXISTIA não é tocada (nem reaberta, nem escondida): a mensagem da
 *     campanha entra nela como qualquer outra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

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
    const { data: aberta, error: erroDaConversa } = await admin.rpc("fn_campaign_open_conversation", {
      p_org: e.orgId,
      p_contact: e.contactId,
      p_channel: e.channelId,
    });
    if (erroDaConversa) throw new Error(`fn_campaign_open_conversation: ${erroDaConversa.message}`);
    const conversaId = (aberta as { conversation_id: string }).conversation_id;

    const msg = await sendMessageHandler(
      admin,
      {
        organization_id: e.orgId,
        // `webhook_source` é o ator que esta base dá a envio nascido de worker; o id é a
        // linha da campanha, para a auditoria da mensagem apontar de onde ela veio.
        actor: { type: "webhook_source", id: e.campaignContactId },
        requestId: `campaign:${e.campaignContactId}`,
      },
      {
        conversation_id: conversaId,
        type: "text",
        body: e.texto,
        // Fica na própria mensagem: de qual campanha e de qual linha ela saiu.
        metadata: { campaign_id: e.campaignId, campaign_contact_id: e.campaignContactId },
      } as Parameters<typeof sendMessageHandler>[2],
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
