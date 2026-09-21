/**
 * O REDIRECIONADOR PÚBLICO DE CLIQUES — as regras puras.
 *
 * O link que vai na mensagem é `<app>/g/<token>`. A rota resolve o token, redireciona NA
 * HORA e só depois registra o clique. O que decide se aquilo foi uma PESSOA mora aqui.
 */
import { conviteValido } from "./schemas";
import type { CampaignClickAgentClass } from "./vocabulario";

/** Visitas de PRÉ-VISUALIZAÇÃO de link: o WhatsApp e os serviços que desenham um cartão do link. */
const PREVIEW = /WhatsApp|facebookexternalhit|Facebot|Twitterbot|TelegramBot|Slackbot|LinkedInBot|Discordbot|SkypeUriPreview|Applebot|Google-PageRenderer|Googlebot/i;
/** Robôs, ferramentas de linha de comando e navegador sem cabeça. */
const ROBO = /bot|crawl|spider|scrapy|curl|wget|python-requests|python-urllib|httpclient|okhttp\/|go-http-client|node-fetch|axios|headless|phantomjs|libwww|java\//i;

/**
 * Quem está pedindo o link. Só `browser` conta como pessoa que clicou.
 *
 * Pré-visualização é ANTES de robô na ordem de teste: o user-agent do WhatsApp contém "bot"
 * em variantes, e é a pré-visualização que o operador quer ver separada. Sem user-agent nenhum
 * é robô — navegador de pessoa sempre manda um.
 */
export function classificarAgente(userAgent: string | null | undefined, metodo: string): CampaignClickAgentClass {
  if (metodo.toUpperCase() === "HEAD") return "bot";
  const ua = (userAgent ?? "").trim();
  if (ua === "") return "bot";
  if (PREVIEW.test(ua)) return "preview";
  if (ROBO.test(ua)) return "bot";
  return "browser";
}

export interface AlvoDoClique {
  campaign_contact_id: string;
  campaign_id: string;
  organization_id: string;
  message_version_id: string | null;
  destination_id: string;
  url: string;
  from_destination_id: string | null;
}

/**
 * Última barreira antes de redirecionar: o destino tem de ser um convite de WhatsApp em https.
 * O banco já só guarda https e a API só cadastra convite de WhatsApp — isto cobre o dado que
 * chegou por outro caminho (SQL direto, importação antiga). Redirecionar para qualquer outro
 * lugar seria um redirecionamento aberto com o domínio do cliente.
 */
export function destinoSeguro(alvo: AlvoDoClique | null): alvo is AlvoDoClique {
  return alvo !== null && typeof alvo.url === "string" && conviteValido(alvo.url);
}
