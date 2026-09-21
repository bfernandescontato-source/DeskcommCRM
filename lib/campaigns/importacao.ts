/**
 * IMPORTAÇÃO DE CONTATOS PARA UMA CAMPANHA — as regras puras (sem banco).
 *
 * A regra de telefone é UMA só, a da casa (`normalizaTelefone` -> `normalizePhoneBR`):
 * a mesma que a ingestão de webhook e a importação de contatos já usam. Este arquivo
 * decide o veredito de UMA linha; o que só o conjunto enxerga (repetido no arquivo,
 * já está na campanha) é decidido no banco, em `fn_campaign_import_finish_validation`.
 *
 * Só roda no servidor: `lib/contacts/csv.ts` puxa o módulo de webhook, que usa
 * `node:crypto`. É por isso que a validação NÃO acontece no navegador.
 */
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { mapHeader, normalizaTelefone } from "@/lib/contacts/csv";

import { chaveDeVariavel, VARIAVEIS_DO_SISTEMA } from "./mensagem";
import type { CampaignImportRejectReason } from "./vocabulario";

/** Arquivo maior que isto é recusado antes do parse (o parse é síncrono no servidor). */
export const IMPORT_MAX_BYTES = 15 * 1024 * 1024;
/** Sem limite artificial pequeno: 45 mil é o caso de partida, não o teto. */
export const IMPORT_MAX_ROWS = 250_000;
export const IMPORT_MAX_COLUNAS = 200;
/** Linhas por ida ao banco (gravar cru, aplicar veredito). */
export const LOTE_DE_LINHAS = 1000;
/** Linhas por ida ao banco ao importar de verdade (uma transação por lote). */
export const LOTE_DE_IMPORTACAO = 1500;

const TETO_NOME = 200;
const TETO_VALOR = 500;
const MAX_EXTRAS = 30;

/** Qual coluna do arquivo vira o quê. Índices contam a partir de 0. */
export interface MapeamentoDeColunas {
  phone: number;
  name: number | null;
  email: number | null;
  /** Colunas extras que viram variável da mensagem (`{{produto}}`). */
  extras: Array<{ key: string; index: number }>;
}

export type VeredictoDaLinha =
  | {
      status: "valid";
      name: string | null;
      phone: string;
      variants: string[];
      email: string | null;
      extras: Record<string, string>;
    }
  | { status: "rejected"; reason: Extract<CampaignImportRejectReason, "empty_phone" | "invalid_phone" | "invalid_email" | "bad_row"> };

/** Tira caracteres de controle e espaço repetido; nunca devolve nulo. */
export function limparTexto(bruto: string | undefined): string {
  return (bruto ?? "").replace(/[\x00-\x1f\x7f\u{2028}\u{2029}]/gu, " ").replace(/\s+/g, " ").trim();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validarLinha(cells: string[], m: MapeamentoDeColunas, colunasDoArquivo: number): VeredictoDaLinha {
  // Mais células que colunas no cabeçalho: a linha está torta (aspas mal fechadas, delimitador no meio).
  if (cells.length > colunasDoArquivo) return { status: "rejected", reason: "bad_row" };

  const telefoneBruto = limparTexto(cells[m.phone]);
  if (telefoneBruto === "") return { status: "rejected", reason: "empty_phone" };
  const phone = normalizaTelefone(telefoneBruto);
  if (phone === null) return { status: "rejected", reason: "invalid_phone" };

  let email: string | null = null;
  if (m.email !== null) {
    const bruto = limparTexto(cells[m.email]);
    if (bruto !== "") {
      if (!EMAIL.test(bruto) || bruto.length > 254) return { status: "rejected", reason: "invalid_email" };
      email = bruto;
    }
  }

  const nome = m.name !== null ? limparTexto(cells[m.name]).slice(0, TETO_NOME) : "";

  const extras: Record<string, string> = {};
  for (const { key, index } of m.extras) {
    const valor = limparTexto(cells[index]).slice(0, TETO_VALOR);
    if (valor !== "") extras[key] = valor;
  }

  return {
    status: "valid",
    name: nome === "" ? null : nome,
    phone,
    variants: phoneLookupVariants(phone),
    email,
    extras,
  };
}

// ── mapeamento sugerido ─────────────────────────────────────────────────────

export interface SugestaoDeMapeamento {
  phone: number | null;
  name: number | null;
  email: number | null;
  /** Todas as OUTRAS colunas, já com a chave de variável que ganhariam. */
  extras: Array<{ key: string; index: number; label: string }>;
}

/**
 * O que o assistente pré-seleciona: telefone/nome/e-mail pelos apelidos de sempre
 * ("Telefone", "Celular", "Nome"…) e as demais colunas como variáveis candidatas.
 */
export function sugerirMapeamento(headers: string[]): SugestaoDeMapeamento {
  const { indices } = mapHeader(headers);
  const phone = indices.phone_number ?? null;
  // A coluna de nome do ARQUIVO (índice), não o nome de uma pessoa: por isso não é a cadeia de rótulo do contato.
  const name = [indices.name, indices.display_name].find((i) => i !== undefined) ?? null;
  const email = indices.email ?? null;
  const usadas = new Set<number>([phone, name, email].filter((i): i is number => i !== null));
  const chavesVistas = new Set<string>(VARIAVEIS_DO_SISTEMA);
  const extras: SugestaoDeMapeamento["extras"] = [];
  headers.forEach((label, index) => {
    if (usadas.has(index)) return;
    const key = chaveDeVariavel(label);
    if (key === "" || chavesVistas.has(key)) return;
    chavesVistas.add(key);
    extras.push({ key, index, label: limparTexto(label) });
  });
  return { phone, name, email, extras: extras.slice(0, MAX_EXTRAS) };
}

/** Confere um mapeamento escolhido contra o arquivo; devolve a razão em texto ou null. */
export function problemaNoMapeamento(m: MapeamentoDeColunas, colunas: number): string | null {
  const ok = (i: number | null) => i === null || (Number.isInteger(i) && i >= 0 && i < colunas);
  if (!ok(m.phone) || m.phone === null) return "A coluna do telefone não existe no arquivo.";
  if (!ok(m.name) || !ok(m.email)) return "Uma das colunas escolhidas não existe no arquivo.";
  if (m.extras.length > MAX_EXTRAS) return `No máximo ${MAX_EXTRAS} colunas extras.`;
  const chaves = new Set<string>();
  for (const e of m.extras) {
    if (!ok(e.index)) return "Uma das colunas extras não existe no arquivo.";
    if ((VARIAVEIS_DO_SISTEMA as readonly string[]).includes(e.key)) {
      return `"${e.key}" é uma variável do sistema; escolha outro nome para a coluna extra.`;
    }
    if (chaves.has(e.key)) return `O nome de variável "${e.key}" foi usado duas vezes.`;
    chaves.add(e.key);
  }
  return null;
}

// ── rejeitados: o que o operador baixa para corrigir ────────────────────────

export const ROTULO_DO_MOTIVO: Record<CampaignImportRejectReason, string> = {
  empty_phone: "Telefone vazio",
  invalid_phone: "Telefone inválido",
  invalid_email: "E-mail inválido",
  duplicate_in_file: "Repetido no arquivo",
  already_in_campaign: "Já está nesta campanha",
  bad_row: "Linha mal formada",
};

/**
 * Uma célula segura para abrir no Excel/Sheets. Texto que começa com `=`, `+`, `-`
 * ou `@` é lido como FÓRMULA — e o CSV que o operador baixa contém o que veio de
 * fora. O apóstrofo faz a planilha tratar como texto.
 */
export function celulaSegura(valor: string): string {
  const v = valor.replace(/\r?\n/g, " ");
  const perigosa = /^[=+\-@\t\r]/.test(v);
  return `"${(perigosa ? `'${v}` : v).replace(/"/g, '""')}"`;
}

export function rejeitadosParaCsv(
  headers: string[],
  linhas: Array<{ line_no: number; reason: CampaignImportRejectReason; cells: string[] | null }>,
): string {
  const cabecalho = ["Linha", "Motivo", ...headers].map(celulaSegura).join(",");
  const corpo = linhas.map((l) =>
    [String(l.line_no + 1), ROTULO_DO_MOTIVO[l.reason] ?? l.reason, ...(l.cells ?? [])].map(celulaSegura).join(","),
  );
  // BOM: o Excel em português só reconhece UTF-8 com ele.
  return `\u{feff}${[cabecalho, ...corpo].join("\r\n")}\r\n`;
}
