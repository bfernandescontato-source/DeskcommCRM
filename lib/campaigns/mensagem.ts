/**
 * A MENSAGEM DA CAMPANHA E SUAS VARIÁVEIS — dados separados de conteúdo.
 *
 * O texto guarda `{{nome}}`, `{{link_grupo}}`, `{{produto}}` crus, na versão da
 * mensagem (imutável). Quem resolve é o envio, por contato, com o que valia no
 * instante do envio. Por isso o link do grupo nunca fica fixo no texto: trocar o
 * destino no meio da campanha não exige editar a mensagem.
 *
 * ─── Diferença para `lib/inbox/template-vars.ts` ───────────────────────────────
 * Lá, variável sem valor mantém o literal `{{x}}`, porque é um atendente que lê
 * antes de enviar. Aqui NINGUÉM lê antes de enviar: um `{{produto}}` literal
 * chegaria a milhares de pessoas. Por isso `renderizarMensagem` devolve a lista
 * do que FALTOU e quem envia não envia quando ela não está vazia (o contato vira
 * `failed` com `missing_variable`, visível e filtrável na Fila).
 */

import { ehIdentificadorTecnico } from "@/lib/contacts/rotulo-do-contato";

/** Variáveis que o sistema resolve sozinho, sem coluna no CSV. */
export const VARIAVEIS_DO_SISTEMA = ["nome", "primeiro_nome", "link_grupo", "bloquear"] as const;
export type VariavelDoSistema = (typeof VARIAVEIS_DO_SISTEMA)[number];

/** Nome de coluna de CSV -> chave de variável (`Produto Comprado` -> `produto_comprado`). */
export function chaveDeVariavel(rotulo: string): string {
  return rotulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const VARIAVEL = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** As variáveis usadas no texto, em minúsculas, sem repetir, na ordem em que aparecem. */
export function variaveisDaMensagem(corpo: string): string[] {
  const achadas: string[] = [];
  for (const m of corpo.matchAll(VARIAVEL)) {
    const chave = (m[1] as string).toLowerCase();
    if (!achadas.includes(chave)) achadas.push(chave);
  }
  return achadas;
}

/** `{{` ou `}}` que sobram depois de tirar as variáveis válidas: chave aberta e não fechada, espaço no meio etc. */
export function chavesSoltas(corpo: string): boolean {
  return /\{\{|\}\}/.test(corpo.replace(VARIAVEL, ""));
}

export interface ContextoDaMensagem {
  /** Nome apresentável do contato; identificador técnico (`123@lid`) conta como ausente. */
  nome?: string | null;
  /** O link que vai no texto: o rastreável (`/g/<token>`) ou o do convite cru. */
  linkGrupo?: string | null;
  /** O link de "bloquear contato" (`/bloquear/<token>`): sempre por token, nunca fixo. */
  linkBloqueio?: string | null;
  /** Colunas extras do CSV, com a chave já normalizada. */
  variaveis?: Record<string, string> | null;
}

export interface MensagemRenderizada {
  texto: string;
  /** O que não teve valor. Não vazia => NÃO envie. */
  faltando: string[];
}

export function renderizarMensagem(corpo: string, ctx: ContextoDaMensagem): MensagemRenderizada {
  const nomeCompleto = (ctx.nome ?? "").trim();
  const nome = nomeCompleto !== "" && !ehIdentificadorTecnico(nomeCompleto) ? nomeCompleto : "";
  const primeiro = nome.split(/\s+/)[0] ?? "";
  const extras = ctx.variaveis ?? {};
  const faltando: string[] = [];

  const texto = corpo.replace(VARIAVEL, (literal, bruto: string) => {
    const chave = bruto.toLowerCase();
    let valor: string;
    if (chave === "nome") valor = nome;
    else if (chave === "primeiro_nome") valor = primeiro;
    else if (chave === "link_grupo") valor = (ctx.linkGrupo ?? "").trim();
    else if (chave === "bloquear") valor = (ctx.linkBloqueio ?? "").trim();
    else valor = (extras[chave] ?? "").trim();
    if (valor === "") {
      if (!faltando.includes(chave)) faltando.push(chave);
      return literal;
    }
    return valor;
  });
  return { texto, faltando };
}

/** Um exemplo para a pré-visualização do assistente: o que o contato de exemplo veria. */
export const CONTATO_DE_EXEMPLO: Required<Pick<ContextoDaMensagem, "nome">> = { nome: "Maria Silva" };

export interface PreviaDaMensagem {
  texto: string;
  /** Colunas do CSV que o texto usa (`{{cidade}}`): a prévia as mostra como ‹cidade›, sem inventar valor. */
  doCsv: string[];
  /** Chave aberta e não fechada: o texto iria com `{{` literal para as pessoas. */
  chavesSoltas: boolean;
  /** O texto usa `{{link_grupo}}` mas ainda não há grupo de destino para preencher. */
  faltaDestino: boolean;
}

/**
 * O que a pessoa veria, para a tela do assistente e a edição da mensagem. Nome de exemplo fixo;
 * o link é o do destino real quando já existe (`linkGrupo`), senão um marcador visível — a prévia
 * nunca finge ter um link que o envio não teria.
 */
export function previaDaMensagem(corpo: string, opcoes: { linkGrupo?: string | null; nome?: string } = {}): PreviaDaMensagem {
  const usadas = variaveisDaMensagem(corpo);
  const doCsv = usadas.filter((k) => !(VARIAVEIS_DO_SISTEMA as readonly string[]).includes(k));
  const link = (opcoes.linkGrupo ?? "").trim();
  const r = renderizarMensagem(corpo, {
    nome: opcoes.nome ?? CONTATO_DE_EXEMPLO.nome,
    linkGrupo: link !== "" ? link : "‹link do grupo›",
    // Na prévia o link de bloqueio é sempre um marcador: o token real só existe por contato, no envio.
    linkBloqueio: "‹link de bloquear›",
    variaveis: Object.fromEntries(doCsv.map((k) => [k, `‹${k}›`])),
  });
  return { texto: r.texto, doCsv, chavesSoltas: chavesSoltas(corpo), faltaDestino: usadas.includes("link_grupo") && link === "" };
}
