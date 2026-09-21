/**
 * Serviço da importação de CSV: upload -> validação -> importação em lotes.
 *
 * Cada passo é uma sequência de chamadas curtas ao banco e nenhum guarda estado em
 * memória: se o servidor reiniciar no meio, o operador volta e o passo continua do
 * ponto em que a staging parou (linhas `raw`, `valid`, `imported`). Todo lote é
 * idempotente no banco.
 */
import { LOTE_DE_IMPORTACAO, LOTE_DE_LINHAS, problemaNoMapeamento, validarLinha, type MapeamentoDeColunas } from "./importacao";
import { CampanhaError, ler, rpc, type Db } from "./service";
import type { CampaignImportRejectReason } from "./vocabulario";

export interface ResumoDaImportacao {
  import_id: string;
  campaign_id: string;
  status: string;
  filename: string;
  total_rows: number;
  headers: string[];
  mapping: MapeamentoDeColunas | null;
  /** Linhas gravadas na staging. */
  found: number;
  raw: number;
  valid: number;
  imported: number;
  rejected: number;
  /** Válidas que já são contatos x que vão ser criados. */
  existing_contacts: number;
  new_contacts: number;
  by_reason: Partial<Record<CampaignImportRejectReason, number>>;
}

export async function resumoDaImportacao(db: Db, orgId: string, importId: string): Promise<ResumoDaImportacao> {
  return rpc<ResumoDaImportacao>(db, "fn_campaign_import_summary", { p_org: orgId, p_import: importId });
}

/** Passo 1: grava o arquivo já lido (cabeçalho + linhas de dados) na staging, em lotes. */
export async function criarImportacao(
  db: Db,
  orgId: string,
  campaignId: string,
  actorId: string,
  arquivo: { filename: string; headers: string[]; rows: string[][] },
): Promise<string> {
  const importId = await rpc<string>(db, "fn_campaign_import_create", {
    p_org: orgId,
    p_campaign: campaignId,
    p_actor: actorId,
    p_filename: arquivo.filename,
    p_headers: arquivo.headers,
    p_total: arquivo.rows.length,
  });
  try {
    for (let i = 0; i < arquivo.rows.length; i += LOTE_DE_LINHAS) {
      const lote = arquivo.rows.slice(i, i + LOTE_DE_LINHAS).map((cells, k) => ({ n: i + k + 1, cells }));
      await rpc<number>(db, "fn_campaign_import_stage_raw", { p_org: orgId, p_import: importId, p_rows: lote });
    }
  } catch (e) {
    // Meio arquivo na staging é dado pessoal sem dono: descarta antes de propagar o erro.
    await rpc(db, "fn_campaign_import_cancel", { p_org: orgId, p_import: importId }).catch(() => undefined);
    throw e;
  }
  return importId;
}

interface LinhaCrua {
  line_no: number;
  cells: string[] | null;
}

/**
 * Passo 2: aplica o mapeamento a TODAS as linhas, grava o veredito de cada uma e fecha
 * a validação no banco (duplicados e "já está na campanha"). Pode ser repetido com outro
 * mapeamento enquanto nada foi importado.
 */
export async function validarImportacao(
  db: Db,
  orgId: string,
  importId: string,
  mapeamento: MapeamentoDeColunas,
): Promise<ResumoDaImportacao> {
  const atual = await resumoDaImportacao(db, orgId, importId);
  const problema = problemaNoMapeamento(mapeamento, atual.headers.length);
  if (problema) throw new CampanhaError({ code: "validation_failed", status: 422, message: problema });

  let depoisDe = 0;
  for (;;) {
    const linhas =
      (await ler<LinhaCrua[]>(
        db
          .from("campaign_import_rows")
          .select("line_no, cells")
          .eq("organization_id", orgId)
          .eq("import_id", importId)
          .gt("line_no", depoisDe)
          .order("line_no", { ascending: true })
          .limit(LOTE_DE_LINHAS),
      )) ?? [];
    if (linhas.length === 0) break;

    const resultados = linhas.map((l) => {
      const v = validarLinha(l.cells ?? [], mapeamento, atual.headers.length);
      return v.status === "valid"
        ? { n: l.line_no, status: "valid", name: v.name, phone: v.phone, variants: v.variants, email: v.email, extras: v.extras }
        : { n: l.line_no, status: "rejected", reason: v.reason };
    });
    await rpc<number>(db, "fn_campaign_import_apply", { p_org: orgId, p_import: importId, p_results: resultados });
    depoisDe = linhas[linhas.length - 1]!.line_no;
  }

  return rpc<ResumoDaImportacao>(db, "fn_campaign_import_finish_validation", {
    p_org: orgId,
    p_import: importId,
    p_mapping: mapeamento,
  });
}

export interface ProgressoDaImportacao {
  processed: number;
  remaining: number;
  status: "importing" | "done";
}

/**
 * Passo 3: importa lotes até acabar ou até o orçamento de tempo estourar. Devolve o que
 * sobrou; a tela chama de novo enquanto `remaining > 0` (é a barra de progresso).
 */
export async function importarEmLotes(
  db: Db,
  orgId: string,
  importId: string,
  actorId: string,
  orcamentoMs = 15_000,
): Promise<ProgressoDaImportacao> {
  const inicio = Date.now();
  let processed = 0;
  for (;;) {
    const r = await rpc<ProgressoDaImportacao>(db, "fn_campaign_import_commit", {
      p_org: orgId,
      p_import: importId,
      p_actor: actorId,
      p_limit: LOTE_DE_IMPORTACAO,
    });
    processed += r.processed;
    if (r.remaining === 0 || Date.now() - inicio > orcamentoMs) {
      return { processed, remaining: r.remaining, status: r.status };
    }
  }
}

/** As primeiras linhas do arquivo, como estão na staging: a prévia que o operador vê antes de mapear as colunas. */
export async function amostraDaImportacao(db: Db, orgId: string, importId: string, quantas = 5): Promise<string[][]> {
  const linhas =
    (await ler<Array<{ cells: string[] | null }>>(
      db
        .from("campaign_import_rows")
        .select("cells")
        .eq("organization_id", orgId)
        .eq("import_id", importId)
        .order("line_no", { ascending: true })
        .limit(quantas),
    )) ?? [];
  return linhas.map((l) => l.cells ?? []);
}

export async function cancelarImportacao(db: Db, orgId: string, importId: string) {
  return rpc<{ changed: boolean; status: string; discarded_rows?: number }>(db, "fn_campaign_import_cancel", {
    p_org: orgId,
    p_import: importId,
  });
}

export interface LinhaRejeitada {
  line_no: number;
  reason: CampaignImportRejectReason;
  cells: string[] | null;
}

/** As linhas recusadas, em páginas por número de linha. O CSV para baixar é montado em cima disto. */
export async function rejeitadosDaImportacao(
  db: Db,
  orgId: string,
  importId: string,
  opcoes: { depoisDe: number; limite: number },
): Promise<{ linhas: LinhaRejeitada[]; proximo: number | null }> {
  const linhas =
    (await ler<LinhaRejeitada[]>(
      db
        .from("campaign_import_rows")
        .select("line_no, reason, cells")
        .eq("organization_id", orgId)
        .eq("import_id", importId)
        .eq("status", "rejected")
        .gt("line_no", opcoes.depoisDe)
        .order("line_no", { ascending: true })
        .limit(opcoes.limite + 1),
    )) ?? [];
  const temMais = linhas.length > opcoes.limite;
  const pagina = temMais ? linhas.slice(0, opcoes.limite) : linhas;
  const ultima = pagina[pagina.length - 1];
  return { linhas: pagina, proximo: temMais && ultima ? ultima.line_no : null };
}
