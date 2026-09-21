/**
 * POST /api/v1/campaigns/[id]/imports — passo 1 da importação: enviar o CSV.
 *
 * Multipart, campo `file`. O servidor lê o arquivo (detecta a codificação, recusa o
 * que não é texto), grava as linhas cruas na staging e devolve o que a tela precisa
 * para o passo seguinte: o cabeçalho, as 5 primeiras linhas e o mapeamento sugerido.
 * Nada vira contato ainda.
 *
 * Aceita campanha em qualquer estado que não seja encerrado — dá para acrescentar
 * gente a uma campanha que já está rodando (entram no fim da fila).
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { IMPORT_MAX_BYTES, IMPORT_MAX_COLUNAS, IMPORT_MAX_ROWS, sugerirMapeamento } from "@/lib/campaigns/importacao";
import { criarImportacao } from "@/lib/campaigns/importacao-service";
import { idInvalido, rotaDeCampanha } from "@/lib/campaigns/rota";
import { decodificarCsv, parseCsv } from "@/lib/contacts/csv";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  return rotaDeCampanha({ acao: "importar", apoio: await requireSupportWrite() }, async (c) => {
    const { id } = await params;
    const invalido = idInvalido(c, id);
    if (invalido) return invalido;
    const recusa = (mensagem: string, status = 422) =>
      fail("validation_failed", c.t(mensagem), status, { requestId: c.requestId });

    let arquivo: File;
    try {
      const f = (await req.formData()).get("file");
      if (!(f instanceof File)) throw new Error("sem arquivo");
      arquivo = f;
    } catch {
      return recusa("Envie o arquivo como multipart/form-data no campo 'file'.");
    }
    const nome = (arquivo.name ?? "").slice(0, 255) || "contatos.csv";
    const tipoOk =
      nome.toLowerCase().endsWith(".csv") || arquivo.type === "text/csv" || arquivo.type === "application/vnd.ms-excel";
    if (!tipoOk) {
      return recusa("Formato não suportado — envie um arquivo .csv. No Excel use 'Salvar como' → 'CSV UTF-8'.");
    }
    if (arquivo.size > IMPORT_MAX_BYTES) {
      return recusa(`${c.t("Arquivo maior que")} ${Math.floor(IMPORT_MAX_BYTES / 1024 / 1024)}MB.`, 413);
    }

    const lido = decodificarCsv(await arquivo.arrayBuffer());
    if ("erro" in lido) return recusa(lido.erro);
    // Linha totalmente em branco (rodapé, quebra dupla) não é registro: sai antes de contar.
    const linhas = parseCsv(lido.texto).filter((l) => l.some((cel) => cel.trim() !== ""));
    if (linhas.length < 2) return recusa("CSV vazio ou sem linhas de dados.");
    const headers = linhas[0]!.map((h) => h.trim());
    const dados = linhas.slice(1);
    if (headers.length > IMPORT_MAX_COLUNAS) return recusa(`${c.t("Colunas demais no arquivo (máximo")} ${IMPORT_MAX_COLUNAS}).`);
    if (dados.length > IMPORT_MAX_ROWS) return recusa(`${c.t("Linhas demais no arquivo (máximo")} ${IMPORT_MAX_ROWS}).`);

    const importId = await criarImportacao(c.db, c.org.orgId, id, c.user.id, { filename: nome, headers, rows: dados });
    return ok(
      {
        import_id: importId,
        filename: nome,
        total_rows: dados.length,
        headers,
        sample: dados.slice(0, 5),
        suggested_mapping: sugerirMapeamento(headers),
      },
      { requestId: c.requestId, status: 201 },
    );
  });
}
