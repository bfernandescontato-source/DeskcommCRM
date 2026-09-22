/**
 * COMO A CENTRAL DE DISPAROS FALA — rótulos, números e frases, num lugar só.
 *
 * Nenhuma tela decide "como escrever 12540" nem "o que é uma taxa de saída": tudo sai daqui, e
 * é por isso que dá para provar por teste que o funil soma, que "não medido" nunca vira zero e
 * que cada evento vira uma frase que um operador entende sem ler JSON.
 */
import type { Alerta } from "./alertas";
import type { VetoDeRitmo } from "./ritmo";
import type { AcaoDaApi } from "./schemas";
import type { CampaignContactStatus, CampaignStatus } from "./vocabulario";

export type VarianteDoBadge = "default" | "neutral" | "success" | "warning" | "error" | "info";

type Traduz = (texto: string) => string;
const igual: Traduz = (texto) => texto;
const comN = (t: Traduz, texto: string, n: number) => t(texto).split("{n}").join(String(n));

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

/**
 * A frase de um evento. Quem fez vem na frente quando é uma pessoa ("Bruno alterou…").
 * `t` traduz a FRASE INTEIRA (os `{marcadores}` são preenchidos depois), para o espanhol poder mudar a ordem.
 */
export function frasesDoEvento(e: EventoParaFrase, ctx: ContextoDeNomes, t: Traduz = igual): string {
  const f = (texto: string, valores: Record<string, string | number> = {}) => Object.entries(valores).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), t(texto));
  const quem = e.actor_name ? `${e.actor_name} ` : "";
  const p = e.payload ?? {};
  const versao = e.message_version_id ? ctx.versoes[e.message_version_id] : undefined;
  const destino = e.destination_id ? ctx.destinos[e.destination_id] : undefined;
  const canal = e.channel_session_id ? ctx.canais[e.channel_session_id] : undefined;

  switch (e.kind) {
    case "created":
      return f("{quem}criou a campanha", { quem });
    case "ready":
      return f("{quem}deixou a campanha pronta para iniciar", { quem });
    case "started":
      return f("{quem}iniciou a campanha", { quem });
    case "paused": {
      const motivo = texto(p.reason);
      return motivo && motivo !== "manual" ? f("{quem}pausou a campanha ({motivo})", { quem, motivo: t(MOTIVO_DA_PAUSA[motivo] ?? motivo) }) : f("{quem}pausou a campanha", { quem });
    }
    case "resumed":
      return f("{quem}retomou a campanha", { quem });
    case "completed":
      return texto(p.reason) === "all_processed" ? f("Campanha concluída: todos os contatos foram processados") : f("{quem}encerrou a campanha", { quem });
    case "cancelled":
      return f("{quem}cancelou a campanha", { quem });
    case "errored":
      return f("A campanha parou por um erro");
    case "imported": {
      const n = inteiro(p.imported);
      const r = inteiro(p.rejected);
      if (n === null) return f("{quem}importou um CSV", { quem });
      return r ? f("{quem}importou um CSV: {n} contatos, {r} recusados", { quem, n: numero(n), r: numero(r) }) : f("{quem}importou um CSV: {n} contatos", { quem, n: numero(n) });
    }
    case "settings_changed": {
      const campos = Object.keys(p).map((k) => t(ROTULO_DA_CONFIGURACAO[k] ?? k));
      return campos.length ? f("{quem}alterou {campos}", { quem, campos: campos.join(", ") }) : f("{quem}alterou as configurações", { quem });
    }
    case "version_created":
      return inteiro(p.version_no) !== null ? f("{quem}criou a versão V{n} da mensagem", { quem, n: inteiro(p.version_no)! }) : f("{quem}criou uma nova versão da mensagem", { quem });
    case "version_activated": {
      const de = inteiro(p.from_version_no);
      const para = inteiro(p.to_version_no);
      if (para === null) return f("{quem}trocou a mensagem ativa", { quem });
      return de !== null ? f("{quem}alterou a mensagem V{de} → V{para}", { quem, de, para }) : f("{quem}definiu a mensagem V{para}", { quem, para });
    }
    case "destination_added":
      return f("{quem}cadastrou o grupo {nome}", { quem, nome: texto(p.name) ?? t("de destino") });
    case "destination_changed": {
      const de = texto(p.from_name);
      const para = texto(p.to_name);
      return de ? f("{quem}alterou o destino {de} → {para}", { quem, de, para: para ?? "—" }) : f("{quem}definiu o destino {para}", { quem, para: para ?? "—" });
    }
    case "channel_added":
      return f("{quem}adicionou {canal} à campanha", { quem, canal: canal ?? t("um número") });
    case "channel_removed":
      return f("{quem}tirou {canal} da campanha", { quem, canal: canal ?? t("um número") });
    case "sent": {
      const base = versao ? f("Mensagem V{n} enviada", { n: versao }) : f("Mensagem enviada");
      return `${base}${canal ? ` ${f("por {canal}", { canal })}` : ""}${p.resolved_manually ? ` ${f("(confirmado por uma pessoa)")}` : ""}`;
    }
    case "send_failed":
      return texto(p.code) ? f("Falha no envio ({codigo})", { codigo: texto(p.code)! }) : f("Falha no envio");
    case "uncertain":
      return f("Envio incerto: não dá para saber se saiu");
    case "skipped":
      return f("Não enviado: {motivo}", { motivo: t(MOTIVO_DE_IGNORADO[texto(p.reason) ?? ""] ?? "contato não pode receber") });
    case "clicked":
      return f("Link clicado");
    case "replied":
      return f("Respondeu");
    case "joined":
      return destino ? f("Entrou no {destino}", { destino }) : f("Entrou no grupo");
    case "left":
      return destino ? f("Saiu do {destino}", { destino }) : f("Saiu do grupo");
    case "removed":
      return destino ? f("Foi removido do {destino}", { destino }) : f("Foi removido do grupo");
    default:
      return e.kind;
  }
}

/**
 * Data e hora curtas para linhas do tempo: "21/09 12:04". `tag` é o idioma de quem lê (`useTagDeIdioma()`):
 * quem escolheu espanhol não pode ler a data em português.
 */
export function dataHoraCurta(iso: string | null | undefined, tag: string, fuso = "America/Sao_Paulo"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const partes = new Intl.DateTimeFormat(tag, { timeZone: fuso, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
  // O espanhol não completa com zero ("21/9"); a coluna alinhada é a mesma nos dois idiomas.
  const dois = (v: string) => v.padStart(2, "0");
  return `${dois(g("day"))}/${dois(g("month"))} ${dois(g("hour"))}:${dois(g("minute"))}`;
}

export function horaCompleta(iso: string | null | undefined, tag: string, fuso = "America/Sao_Paulo"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(tag, { timeZone: fuso, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
}

/** "há 5 min", "há 2 h", "agora": quanto tempo faz. */
export function haQuantoTempo(iso: string | null | undefined, agora = new Date(), t: Traduz = igual): string {
  if (!iso) return "—";
  const ms = agora.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(Math.round(ms / 1000), 0);
  if (s < 45) return t("agora");
  const min = Math.round(s / 60);
  if (min < 60) return comN(t, "há {n} min", min);
  const h = Math.round(min / 60);
  if (h < 24) return comN(t, "há {n} h", h);
  return comN(t, "há {n} d", Math.round(h / 24));
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

/** Por que um número não enviou agora — a pessoa vê o motivo, não um número parado sem explicação. */
export const MOTIVO_DO_VETO: Record<VetoDeRitmo, string> = {
  outside_window: "fora do horário de envio",
  warmup_cap: "limite de aquecimento do número",
  daily_cap: "limite diário do número",
  interval: "aguardando o intervalo entre envios",
  campaign_cap: "limite diário da campanha",
};

export const ROTULO_DO_CANAL: Record<string, { label: string; variante: VarianteDoBadge }> = {
  WORKING: { label: "Conectado", variante: "success" },
  STARTING: { label: "Conectando", variante: "info" },
  SCAN_QR_CODE: { label: "Aguardando QR", variante: "warning" },
  STOPPED: { label: "Desconectado", variante: "error" },
  FAILED: { label: "Falhou", variante: "error" },
};

/** Como um NÚMERO DE ENVIO (sessão de canal, não contato) se chama na tela: apelido, senão o telefone, senão um nome genérico. */
export function rotuloDoCanal(session: { display_name: string | null; phone_number: string | null } | null | undefined): string {
  return session?.display_name?.trim() || session?.phone_number?.trim() || "Número sem nome";
}

/** Os nomes que as frases dos eventos precisam (versão, grupo, número), tirados da Visão geral. */
export function contextoDeNomes(d: {
  versions: Array<{ id: string; version_no: number }>;
  destinations: Array<{ id: string; name: string }>;
  channels: Array<{ channel_session_id: string; session: { display_name: string | null; phone_number: string | null } | null }>;
}): ContextoDeNomes {
  return {
    versoes: Object.fromEntries(d.versions.map((v) => [v.id, v.version_no])),
    destinos: Object.fromEntries(d.destinations.map((x) => [x.id, x.name])),
    canais: Object.fromEntries(d.channels.map((c) => [c.channel_session_id, rotuloDoCanal(c.session)])),
  };
}

export type EstadoDoContato = "NO_GRUPO" | "SAIU_DO_GRUPO" | "RESPONDEU" | "CLICOU" | "ENVIADO" | "PENDENTE" | "PROCESSANDO" | "FALHOU" | "INCERTO" | "IGNORADO" | "CANCELADO";

/**
 * Onde a pessoa está AGORA, do estágio mais avançado para o menos. Engajamento não é status:
 * quem foi enviado, clicou, respondeu e entrou no grupo é, hoje, "no grupo".
 */
export function estadoDoContato(c: { status: CampaignContactStatus; clicked_at: string | null; replied_at: string | null; joined_at: string | null; left_at: string | null }): EstadoDoContato {
  if (c.status === "sent") {
    if (c.left_at) return "SAIU_DO_GRUPO";
    if (c.joined_at) return "NO_GRUPO";
    if (c.replied_at) return "RESPONDEU";
    if (c.clicked_at) return "CLICOU";
    return "ENVIADO";
  }
  return { pending: "PENDENTE", queued: "PENDENTE", processing: "PROCESSANDO", failed: "FALHOU", uncertain: "INCERTO", skipped: "IGNORADO", cancelled: "CANCELADO" }[c.status] as EstadoDoContato;
}

// ── filtros rápidos da Fila ─────────────────────────────────────────────────

export interface FiltroRapido {
  id: string;
  rotulo: string;
  /** O que vai para a API. Vazio = tudo. */
  filtro: { status?: CampaignContactStatus[]; clicked?: boolean; replied?: boolean };
}

export const FILTROS_RAPIDOS: FiltroRapido[] = [
  { id: "todos", rotulo: "Todos", filtro: {} },
  { id: "pendentes", rotulo: "Pendentes", filtro: { status: ["pending", "queued", "processing"] } },
  { id: "enviados", rotulo: "Enviados", filtro: { status: ["sent"] } },
  { id: "clicaram", rotulo: "Clicaram", filtro: { clicked: true } },
  { id: "responderam", rotulo: "Responderam", filtro: { replied: true } },
  { id: "falhas", rotulo: "Falhas", filtro: { status: ["failed"] } },
  { id: "incertos", rotulo: "Incertos", filtro: { status: ["uncertain"] } },
  { id: "ignorados", rotulo: "Ignorados", filtro: { status: ["skipped"] } },
];

/** `?status=failed` / `?status=uncertain` (os botões dos alertas) -> o filtro rápido que o representa. */
export function filtroRapidoDoStatus(status: string | null | undefined): string {
  const achado = FILTROS_RAPIDOS.find((f) => f.filtro.status?.length === 1 && f.filtro.status[0] === status);
  return achado?.id ?? "todos";
}

// ── assistente: o que falta e quanto vai demorar ────────────────────────────

export interface ItemDaRevisao {
  id: "contatos" | "mensagem" | "destino" | "envio";
  ok: boolean;
  titulo: string;
  detalhe: string;
}

/** O texto usa `{{link_grupo}}`? Mesma regra do banco (`fn_campaign_assert_startable`): sem distinguir caixa. */
export const usaLinkDoGrupo = (corpo: string | null | undefined): boolean => /\{\{\s*link_grupo\s*\}\}/i.test(corpo ?? "");

/**
 * O que a campanha precisa para iniciar, na ordem do assistente. É o espelho de
 * `fn_campaign_assert_startable`: contatos a enviar, mensagem, destino (só se o texto usa o link do
 * grupo) e ao menos um número. O banco confere de verdade ao iniciar; isto existe para a pessoa ver
 * o que falta ANTES de clicar.
 */
export function revisaoDaCampanha(d: { pendentes: number; corpoAtivo: string | null; temDestinoAtivo: boolean; numerosEscolhidos: number }, t: Traduz = igual): ItemDaRevisao[] {
  const precisaDeGrupo = usaLinkDoGrupo(d.corpoAtivo);
  const n = d.numerosEscolhidos;
  const comNumero = (texto: string, valor: number) => t(texto).split("{n}").join(numero(valor));
  return [
    { id: "contatos", ok: d.pendentes > 0, titulo: t("Contatos"), detalhe: d.pendentes > 0 ? comNumero("{n} contatos na fila", d.pendentes) : t("Importe os contatos") },
    { id: "mensagem", ok: d.corpoAtivo !== null, titulo: t("Mensagem"), detalhe: d.corpoAtivo !== null ? t("Mensagem pronta") : t("Escreva a mensagem") },
    {
      id: "destino",
      ok: !precisaDeGrupo || d.temDestinoAtivo,
      titulo: t("Grupo de destino"),
      detalhe: !precisaDeGrupo ? t("A mensagem não usa o link de um grupo") : d.temDestinoAtivo ? t("Grupo escolhido") : t("A mensagem usa {{link_grupo}}: escolha o grupo"),
    },
    { id: "envio", ok: n > 0, titulo: t("Números"), detalhe: n > 0 ? comNumero(n > 1 ? "{n} números escolhidos" : "{n} número escolhido", n) : t("Escolha ao menos um número") },
  ];
}

export interface EstimativaDeEnvio {
  /** Quantas mensagens saem por dia, somando os números escolhidos. */
  porDia: number;
  /** Dias para esvaziar a fila; `null` = não dá para estimar (sem número ou sem vazão). */
  dias: number | null;
}

const SEGUNDOS_POR_DIA = 86_400;

/**
 * Quanto tempo a fila leva. Cada número envia no máximo o MENOR entre: o limite diário dele, o teto
 * da campanha (se houver) e o que cabe no intervalo fixo (`86400 / intervalo`). É um teto de vazão:
 * o real pode ser menor (horário de envio, aquecimento de número novo, números que caem).
 */
export function estimativaDeEnvio(d: { pendentes: number; limitesDiarios: number[]; intervaloSegundos: number; tetoDaCampanha: number | null }): EstimativaDeEnvio {
  const cabeNoIntervalo = d.intervaloSegundos > 0 ? Math.floor(SEGUNDOS_POR_DIA / d.intervaloSegundos) : 0;
  const porDia = d.limitesDiarios.reduce((soma, limite) => soma + Math.max(Math.min(limite, d.tetoDaCampanha ?? Infinity, cabeNoIntervalo), 0), 0);
  return { porDia, dias: porDia > 0 ? Math.ceil(d.pendentes / porDia) : null };
}

/** "cerca de 3 semanas", "2 dias", "menos de 1 dia". */
export function duracaoEmPalavras(dias: number | null, t: Traduz = igual): string {
  if (dias === null) return t("não dá para estimar");
  if (dias <= 1) return t("menos de 1 dia");
  if (dias < 14) return comN(t, "cerca de {n} dias", dias);
  if (dias < 60) return comN(t, "cerca de {n} semanas", Math.round(dias / 7));
  return comN(t, "cerca de {n} meses", Math.round(dias / 30));
}

// ── entradas e saídas do grupo: o que o CRM enxerga ─────────────────────────

/**
 * O CRM enxerga as entradas e saídas deste grupo?
 *
 *  - `nao_monitorado`: o destino não tem o ID do grupo — não há como receber o aviso do WhatsApp.
 *  - `aguardando`: tem o ID, mas NENHUM aviso de entrada/saída chegou ainda. Não é "zero pessoas": é
 *    "ainda sem evidência" (grupo novo, número que não está no grupo, ou o aviso não está chegando).
 *  - `medido`: já chegou ao menos um aviso; os números passam a valer.
 *
 * Zero mostrado com segurança quando não se está medindo seria uma mentira; por isso o terceiro estado.
 */
export type Medicao = "nao_monitorado" | "aguardando" | "medido";

export function medicaoDoDestino(d: { group_chat_id: string | null; joined_total?: number | null; members_left?: number | null }): Medicao {
  if (!d.group_chat_id) return "nao_monitorado";
  return (d.joined_total ?? 0) > 0 || (d.members_left ?? 0) > 0 ? "medido" : "aguardando";
}

/**
 * Quantas pessoas entraram nos grupos SEM serem identificadas como contatos desta campanha. Vem de
 * evidência (o aviso do WhatsApp existe) e não de suposição: a pessoa pode ter entrado por outro
 * caminho, ou o WhatsApp só informou um identificador que o CRM não conhece.
 */
export function entradasSemIdentificacao(destinos: Array<{ joined_total?: number | null }>, identificados: number): number {
  const total = destinos.reduce((soma, d) => soma + (d.joined_total ?? 0), 0);
  return Math.max(total - identificados, 0);
}
