/**
 * COMO A CENTRAL DE DISPAROS FALA — rótulos, números e frases, num lugar só.
 *
 * Nenhuma tela decide "como escrever 12540" nem "o que é uma taxa de saída": tudo sai daqui, e
 * é por isso que dá para provar por teste que o funil soma, que "não medido" nunca vira zero e
 * que cada evento vira uma frase que um operador entende sem ler JSON.
 */
import type { Alerta } from "./alertas";
import type { AcaoDaApi } from "./schemas";
import type { CampaignStatus } from "./vocabulario";

export type VarianteDoBadge = "default" | "neutral" | "success" | "warning" | "error" | "info";

const NUMERO = new Intl.NumberFormat("pt-BR");

/** 12540 -> "12.540". Nunca "NaN": o que não é número vira "—". */
export function numero(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? NUMERO.format(n) : "—";
}

/** 0,8219 de 1 -> "82,2%". Denominador zero ou ausente é "—": uma taxa sem base não é 0%. */
export function percentual(parte: number | null | undefined, todo: number | null | undefined, casas = 1): string {
  if (typeof parte !== "number" || typeof todo !== "number" || !Number.isFinite(parte) || !Number.isFinite(todo) || todo <= 0) return "—";
  return `${((parte / todo) * 100).toFixed(casas).replace(".", ",")}%`;
}

// ── estados ─────────────────────────────────────────────────────────────────

export const ROTULO_DA_CAMPANHA: Record<CampaignStatus, { label: string; variante: VarianteDoBadge }> = {
  draft: { label: "Rascunho", variante: "neutral" },
  ready: { label: "Pronta", variante: "info" },
  running: { label: "Em andamento", variante: "success" },
  paused: { label: "Pausada", variante: "warning" },
  completed: { label: "Concluída", variante: "neutral" },
  cancelled: { label: "Cancelada", variante: "neutral" },
  error: { label: "Erro", variante: "error" },
};

export const ROTULO_DO_ESTADO_DO_CONTATO: Record<string, { label: string; variante: VarianteDoBadge }> = {
  NO_GRUPO: { label: "No grupo", variante: "success" },
  SAIU_DO_GRUPO: { label: "Saiu do grupo", variante: "warning" },
  RESPONDEU: { label: "Respondeu", variante: "success" },
  CLICOU: { label: "Clicou", variante: "info" },
  ENVIADO: { label: "Enviado", variante: "default" },
  PENDENTE: { label: "Pendente", variante: "neutral" },
  PROCESSANDO: { label: "Processando", variante: "info" },
  FALHOU: { label: "Falhou", variante: "error" },
  INCERTO: { label: "Incerto", variante: "warning" },
  IGNORADO: { label: "Ignorado", variante: "neutral" },
  CANCELADO: { label: "Cancelado", variante: "neutral" },
};

/** O status BRUTO do envio, como a Fila mostra na coluna Status. */
export const ROTULO_DO_ENVIO: Record<string, { label: string; variante: VarianteDoBadge }> = {
  pending: { label: "Pendente", variante: "neutral" },
  queued: { label: "Na vez", variante: "info" },
  processing: { label: "Processando", variante: "info" },
  sent: { label: "Enviado", variante: "success" },
  failed: { label: "Falhou", variante: "error" },
  uncertain: { label: "Incerto", variante: "warning" },
  skipped: { label: "Ignorado", variante: "neutral" },
  cancelled: { label: "Cancelado", variante: "neutral" },
};

export const MOTIVO_DE_IGNORADO: Record<string, string> = {
  blocked: "contato bloqueado",
  no_phone: "sem telefone",
  declined_marketing: "recusou receber mensagens",
  anonymized: "contato anonimizado",
  merged: "contato mesclado",
};

export const MOTIVO_DA_PAUSA: Record<string, string> = {
  manual: "pausada por você",
  no_channel: "nenhum número conectado",
  channel_down: "um número caiu",
  no_destination: "sem grupo de destino ativo",
};

export const ROTULO_DA_CONFIGURACAO: Record<string, string> = {
  name: "nome",
  tracking_enabled: "link rastreado",
  channel_policy: "quando um número cai",
  send_interval_seconds: "intervalo entre envios",
  daily_cap_per_channel: "limite diário por número",
};

export const MOTIVO_DE_REJEICAO: Record<string, string> = {
  empty_phone: "Telefone vazio",
  invalid_phone: "Telefone inválido",
  invalid_email: "E-mail inválido",
  duplicate_in_file: "Repetido no arquivo",
  already_in_campaign: "Já está nesta campanha",
  bad_row: "Linha mal formada",
};

// ── funil ───────────────────────────────────────────────────────────────────

export interface EntradaDoFunil {
  total: number;
  sent: number;
  clicked: number;
  joined: number;
  left: number;
}

export interface EtapaDoFunil {
  chave: "total" | "sent" | "clicked" | "joined" | "left" | "stayed";
  rotulo: string;
  valor: number | null;
  /** Nota curta sobre a etapa ("não medido" quando o CRM não enxerga o grupo). */
  nota?: string;
}

/**
 * O funil de uma campanha: contatos -> enviados -> clicaram -> entraram -> saíram -> permanecem.
 * `medido` diz se o CRM enxerga entradas e saídas dos grupos. Sem isso, "entraram", "saíram" e
 * "permanecem" são `null` — não medido NUNCA vira zero, e zero dito com segurança seria mentira.
 */
export function funil(c: EntradaDoFunil, medido: boolean): { etapas: EtapaDoFunil[]; taxas: Array<{ rotulo: string; valor: string }> } {
  const permanecem = medido ? Math.max(c.joined - c.left, 0) : null;
  const etapas: EtapaDoFunil[] = [
    { chave: "total", rotulo: "Contatos", valor: c.total },
    { chave: "sent", rotulo: "Enviados", valor: c.sent },
    { chave: "clicked", rotulo: "Clicaram", valor: c.clicked },
    { chave: "joined", rotulo: "Entraram", valor: medido ? c.joined : null, ...(medido ? {} : { nota: "não medido" }) },
    { chave: "left", rotulo: "Saíram", valor: medido ? c.left : null, ...(medido ? {} : { nota: "não medido" }) },
    { chave: "stayed", rotulo: "Permanecem", valor: permanecem, ...(medido ? {} : { nota: "não medido" }) },
  ];
  const taxas = [
    { rotulo: "Taxa de envio", valor: percentual(c.sent, c.total) },
    { rotulo: "CTR (clique / enviado)", valor: percentual(c.clicked, c.sent) },
    { rotulo: "Clique → entrada", valor: medido ? percentual(c.joined, c.clicked) : "não medido" },
    { rotulo: "Taxa de saída", valor: medido ? percentual(c.left, c.joined) : "não medido" },
    { rotulo: "Taxa de permanência", valor: medido ? percentual(permanecem, c.joined) : "não medido" },
  ];
  return { etapas, taxas };
}

// ── eventos em frases ───────────────────────────────────────────────────────

export interface ContextoDeNomes {
  /** id da versão -> número (V1, V2…). */
  versoes: Record<string, number>;
  destinos: Record<string, string>;
  canais: Record<string, string>;
}

export interface EventoParaFrase {
  kind: string;
  actor_name?: string | null;
  message_version_id?: string | null;
  destination_id?: string | null;
  channel_session_id?: string | null;
  payload: Record<string, unknown>;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const inteiro = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A frase de um evento. Quem fez vem na frente quando é uma pessoa ("Bruno alterou…"). */
export function frasesDoEvento(e: EventoParaFrase, ctx: ContextoDeNomes): string {
  const quem = e.actor_name ? `${e.actor_name} ` : "";
  const p = e.payload ?? {};
  const versao = e.message_version_id ? ctx.versoes[e.message_version_id] : undefined;
  const destino = e.destination_id ? ctx.destinos[e.destination_id] : undefined;
  const canal = e.channel_session_id ? ctx.canais[e.channel_session_id] : undefined;

  switch (e.kind) {
    case "created":
      return `${quem}criou a campanha`;
    case "ready":
      return `${quem}deixou a campanha pronta para iniciar`;
    case "started":
      return `${quem}iniciou a campanha`;
    case "paused": {
      const motivo = texto(p.reason);
      return `${quem}pausou a campanha${motivo && motivo !== "manual" ? ` (${MOTIVO_DA_PAUSA[motivo] ?? motivo})` : ""}`;
    }
    case "resumed":
      return `${quem}retomou a campanha`;
    case "completed":
      return texto(p.reason) === "all_processed" ? "Campanha concluída: todos os contatos foram processados" : `${quem}encerrou a campanha`;
    case "cancelled":
      return `${quem}cancelou a campanha`;
    case "errored":
      return "A campanha parou por um erro";
    case "imported": {
      const n = inteiro(p.imported);
      const r = inteiro(p.rejected);
      return `${quem}importou um CSV${n !== null ? `: ${numero(n)} contatos` : ""}${r ? `, ${numero(r)} recusados` : ""}`;
    }
    case "settings_changed":
    {
      const campos = Object.keys(p).map((k) => ROTULO_DA_CONFIGURACAO[k] ?? k);
      return `${quem}alterou ${campos.length ? campos.join(", ") : "as configurações"}`;
    }
    case "version_created":
      return inteiro(p.version_no) !== null ? `${quem}criou a versão V${inteiro(p.version_no)} da mensagem` : `${quem}criou uma nova versão da mensagem`;
    case "version_activated": {
      const de = inteiro(p.from_version_no);
      const para = inteiro(p.to_version_no);
      if (para === null) return `${quem}trocou a mensagem ativa`;
      return de !== null ? `${quem}alterou a mensagem V${de} → V${para}` : `${quem}definiu a mensagem V${para}`;
    }
    case "destination_added":
      return `${quem}cadastrou o grupo ${texto(p.name) ?? "de destino"}`;
    case "destination_changed": {
      const de = texto(p.from_name);
      const para = texto(p.to_name);
      return de ? `${quem}alterou o destino ${de} → ${para ?? "—"}` : `${quem}definiu o destino ${para ?? "—"}`;
    }
    case "channel_added":
      return `${quem}adicionou ${canal ?? "um número"} à campanha`;
    case "channel_removed":
      return `${quem}tirou ${canal ?? "um número"} da campanha`;
    case "sent":
      return `${versao ? `Mensagem V${versao}` : "Mensagem"} enviada${canal ? ` por ${canal}` : ""}${p.resolved_manually ? " (confirmado por uma pessoa)" : ""}`;
    case "send_failed":
      return `Falha no envio${texto(p.code) ? ` (${texto(p.code)})` : ""}`;
    case "uncertain":
      return "Envio incerto: não dá para saber se saiu";
    case "skipped":
      return `Não enviado: ${MOTIVO_DE_IGNORADO[texto(p.reason) ?? ""] ?? "contato não pode receber"}`;
    case "clicked":
      return "Link clicado";
    case "replied":
      return "Respondeu";
    case "joined":
      return `Entrou${destino ? ` no ${destino}` : " no grupo"}`;
    case "left":
      return `Saiu${destino ? ` do ${destino}` : " do grupo"}`;
    case "removed":
      return `Foi removido${destino ? ` do ${destino}` : " do grupo"}`;
    default:
      return e.kind;
  }
}

/** Data e hora curtas para linhas do tempo: "21/09 12:04". */
export function dataHoraCurta(iso: string | null | undefined, fuso = "America/Sao_Paulo"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const partes = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")} ${g("hour")}:${g("minute")}`;
}

export function horaCompleta(iso: string | null | undefined, fuso = "America/Sao_Paulo"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
}

/** "há 5 min", "há 2 h", "agora": quanto tempo faz. */
export function haQuantoTempo(iso: string | null | undefined, agora = new Date()): string {
  if (!iso) return "—";
  const ms = agora.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(Math.round(ms / 1000), 0);
  if (s < 45) return "agora";
  const min = Math.round(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

// ── o que se pode fazer, por estado ─────────────────────────────────────────

export interface AcaoNaTela {
  acao: AcaoDaApi;
  rotulo: string;
  /** Pede confirmação com o texto de `aviso` antes de executar. */
  confirmar: boolean;
  aviso?: string;
  tom: "primario" | "neutro" | "perigo";
}

/**
 * As ações que a campanha aceita a partir de cada estado. É o ESPELHO de `fn_campaign_transition`
 * (o banco decide de verdade e recusa o resto): existe para a tela não oferecer botão que voltaria
 * como "transição inválida". Um teste amarra esta tabela à do banco.
 *
 * PAUSAR e ENCERRAR são coisas diferentes, e o texto diz qual: pausar guarda o ponto exato e volta
 * de onde parou; encerrar termina para sempre e cancela o que ainda estava na fila.
 */
export function acoesDaCampanha(status: CampaignStatus): AcaoNaTela[] {
  const iniciar: AcaoNaTela = {
    acao: "start",
    rotulo: "Iniciar campanha",
    confirmar: true,
    aviso: "Ao iniciar, as mensagens começam a sair pelos números escolhidos. Um envio não pode ser desfeito. Você pode pausar a qualquer momento, e a fila continua exatamente do ponto em que parou.",
    tom: "primario",
  };
  const pausar: AcaoNaTela = { acao: "pause", rotulo: "Pausar", confirmar: false, tom: "neutro" };
  const retomar: AcaoNaTela = { acao: "resume", rotulo: "Retomar", confirmar: false, tom: "primario" };
  const encerrar: AcaoNaTela = {
    acao: "complete",
    rotulo: "Encerrar",
    confirmar: true,
    aviso: "Encerrar termina a campanha de vez: quem ainda não recebeu deixa de ser contatado e o grupo ativo é fechado. Para só parar um pouco e continuar depois, use Pausar.",
    tom: "perigo",
  };
  const descartar: AcaoNaTela = {
    acao: "cancel",
    rotulo: "Descartar campanha",
    confirmar: true,
    aviso: "A campanha não terá envios e não poderá ser retomada.",
    tom: "perigo",
  };
  switch (status) {
    case "draft":
    case "ready":
      return [iniciar, descartar];
    case "running":
      return [pausar, encerrar];
    case "paused":
    case "error":
      return [retomar, encerrar];
    default:
      return [];
  }
}

/** A tela para onde o botão de um alerta leva. `null` = o alerta é só informação. */
export function destinoDoAlerta(campaignId: string, a: Pick<Alerta, "action">): string | null {
  const base = `/app/disparos/${campaignId}`;
  switch (a.action) {
    case "switch_destination":
      return `${base}?aba=destinos`;
    case "resume":
      return base;
    case "edit_channels":
      return `${base}?aba=visao#numeros`;
    case "review_uncertain":
      return `${base}?aba=fila&status=uncertain`;
    case "review_failures":
      return `${base}?aba=fila&status=failed`;
    case "view_import":
      return `${base}?aba=atividade`;
    default:
      return null;
  }
}

export const ROTULO_DO_ALERTA: Record<Alerta["action"], string> = {
  switch_destination: "Trocar grupo",
  resume: "Ver campanha",
  edit_channels: "Ver números",
  review_uncertain: "Ver incertos",
  review_failures: "Ver falhas",
  view_import: "Ver importação",
  none: "",
};
