import { describe, expect, it } from "vitest";

import {
  celulaSegura,
  limparTexto,
  problemaNoMapeamento,
  rejeitadosParaCsv,
  sugerirMapeamento,
  validarLinha,
  type MapeamentoDeColunas,
} from "@/lib/campaigns/importacao";
import { mapeamentoSchema } from "@/lib/campaigns/schemas";
import { CAMPAIGN_IMPORT_REJECT_REASONS } from "@/lib/campaigns/vocabulario";

const M: MapeamentoDeColunas = { phone: 1, name: 0, email: 2, extras: [{ key: "produto", index: 3 }] };
const COLUNAS = 4;

describe("validarLinha — a regra de telefone é a da casa", () => {
  it("normaliza telefone brasileiro em vários formatos para E.164 e gera as variantes de busca", () => {
    for (const bruto of ["(11) 99999-8888", "11999998888", "+55 11 99999-8888", "5511999998888"]) {
      const v = validarLinha(["Maria Silva", bruto, "", ""], M, COLUNAS);
      expect(v, bruto).toMatchObject({ status: "valid", phone: "+5511999998888" });
      if (v.status === "valid") expect(v.variants).toContain("+5511999998888");
    }
  });

  it("aceita número internacional que já vem com +", () => {
    expect(validarLinha(["Ana", "+1 415 555 0132", "", ""], M, COLUNAS)).toMatchObject({ status: "valid", phone: "+14155550132" });
  });

  it("recusa telefone vazio, curto ou com letra — cada um com o seu motivo", () => {
    expect(validarLinha(["Ana", "", "", ""], M, COLUNAS)).toEqual({ status: "rejected", reason: "empty_phone" });
    expect(validarLinha(["Ana", "   ", "", ""], M, COLUNAS)).toEqual({ status: "rejected", reason: "empty_phone" });
    expect(validarLinha(["Ana", "12345", "", ""], M, COLUNAS)).toEqual({ status: "rejected", reason: "invalid_phone" });
    expect(validarLinha(["Ana", "telefone", "", ""], M, COLUNAS)).toEqual({ status: "rejected", reason: "invalid_phone" });
    // 12 ou 13 dígitos sem + precisam começar com 55.
    expect(validarLinha(["Ana", "441234567890", "", ""], M, COLUNAS)).toEqual({ status: "rejected", reason: "invalid_phone" });
  });

  it("e-mail mal formado recusa a linha; e-mail vazio é permitido", () => {
    expect(validarLinha(["Ana", "11999998888", "ana@", ""], M, COLUNAS)).toEqual({ status: "rejected", reason: "invalid_email" });
    expect(validarLinha(["Ana", "11999998888", "", ""], M, COLUNAS)).toMatchObject({ status: "valid", email: null });
    expect(validarLinha(["Ana", "11999998888", "ana@exemplo.com", ""], M, COLUNAS)).toMatchObject({ email: "ana@exemplo.com" });
  });

  it("linha com mais células que o cabeçalho é mal formada (aspas ou delimitador soltos)", () => {
    expect(validarLinha(["Ana", "11999998888", "", "x", "sobrou"], M, COLUNAS)).toEqual({ status: "rejected", reason: "bad_row" });
  });

  it("linha curta não quebra: as colunas que faltam ficam vazias", () => {
    expect(validarLinha(["Ana", "11999998888"], M, COLUNAS)).toMatchObject({ status: "valid", name: "Ana", email: null, extras: {} });
  });

  it("colunas extras viram variáveis; vazias e espaçadas não entram", () => {
    const v = validarLinha(["Ana", "11999998888", "", "  Tênis   de   corrida "], M, COLUNAS);
    expect(v).toMatchObject({ status: "valid", extras: { produto: "Tênis de corrida" } });
    expect(validarLinha(["Ana", "11999998888", "", ""], M, COLUNAS)).toMatchObject({ extras: {} });
  });

  it("limpa caracteres de controle e limita o tamanho do nome", () => {
    const v = validarLinha([`Ana\x00\x07\nSilva${"x".repeat(400)}`, "11999998888", "", ""], M, COLUNAS);
    expect(v.status).toBe("valid");
    if (v.status === "valid") {
      expect(v.name).not.toMatch(/[\x00-\x1f]/);
      expect(v.name!.length).toBeLessThanOrEqual(200);
    }
    expect(limparTexto("  a\tb\n c  ")).toBe("a b c");
    expect(limparTexto(undefined)).toBe("");
  });

  it("sem coluna de nome/e-mail mapeada, esses campos são ignorados", () => {
    const so: MapeamentoDeColunas = { phone: 0, name: null, email: null, extras: [] };
    expect(validarLinha(["11999998888", "ana@exemplo.com"], so, 2)).toMatchObject({ status: "valid", name: null, email: null });
  });

  it("todo motivo que o TypeScript devolve existe no vocabulário do banco", () => {
    for (const r of ["empty_phone", "invalid_phone", "invalid_email", "bad_row"]) {
      expect(CAMPAIGN_IMPORT_REJECT_REASONS).toContain(r);
    }
  });
});

describe("mapeamento de colunas", () => {
  it("sugere telefone, nome e e-mail pelos apelidos e deixa o resto como variável candidata", () => {
    const s = sugerirMapeamento(["Nome", "Celular", "E-mail", "Produto Comprado", "Cidade/UF", "Nome"]);
    expect(s).toMatchObject({ phone: 1, name: 0, email: 2 });
    expect(s.extras.map((e) => e.key)).toEqual(["produto_comprado", "cidade_uf"]);
    // A segunda coluna "Nome" cairia em {{nome}}, que é variável do sistema: não é oferecida.
    expect(s.extras.some((e) => e.key === "nome")).toBe(false);
  });

  it("sem coluna de telefone, sugere nada (a tela pede para escolher)", () => {
    expect(sugerirMapeamento(["Produto", "Cidade"]).phone).toBeNull();
  });

  it("confere o mapeamento contra o arquivo", () => {
    expect(problemaNoMapeamento(M, 4)).toBeNull();
    expect(problemaNoMapeamento({ ...M, phone: 9 }, 4)).toMatch(/telefone/);
    expect(problemaNoMapeamento({ ...M, name: 7 }, 4)).toMatch(/colunas escolhidas/);
    expect(problemaNoMapeamento({ ...M, extras: [{ key: "nome", index: 3 }] }, 4)).toMatch(/variável do sistema/);
    expect(problemaNoMapeamento({ ...M, extras: [{ key: "a", index: 3 }, { key: "a", index: 2 }] }, 4)).toMatch(/duas vezes/);
    expect(problemaNoMapeamento({ ...M, extras: [{ key: "a", index: 40 }] }, 4)).toMatch(/extras não existe/);
  });

  it("o corpo do mapeamento é estrito", () => {
    expect(mapeamentoSchema.safeParse({ phone: 1 }).success).toBe(true);
    expect(mapeamentoSchema.parse({ phone: 1 })).toMatchObject({ name: null, email: null, extras: [] });
    expect(mapeamentoSchema.safeParse({ phone: 1, organization_id: "x" }).success).toBe(false);
    expect(mapeamentoSchema.safeParse({ phone: -1 }).success).toBe(false);
    expect(mapeamentoSchema.safeParse({ phone: 1, extras: [{ key: "Produto Comprado", index: 2 }] }).success).toBe(false);
  });
});

describe("CSV dos rejeitados", () => {
  it("neutraliza fórmula: o conteúdo veio de fora e vai abrir numa planilha", () => {
    expect(celulaSegura("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(celulaSegura("+5511999998888")).toBe(`"'+5511999998888"`);
    expect(celulaSegura("-1")).toBe(`"'-1"`);
    expect(celulaSegura("@SOMA(A1)")).toBe(`"'@SOMA(A1)"`);
    expect(celulaSegura("Maria")).toBe(`"Maria"`);
    expect(celulaSegura('diz "oi"')).toBe(`"diz ""oi"""`);
    expect(celulaSegura("linha1\nlinha2")).toBe(`"linha1 linha2"`);
  });

  it("monta o arquivo com BOM, cabeçalho, número de linha como na planilha e motivo em português", () => {
    const csv = rejeitadosParaCsv(["Nome", "Telefone"], [
      { line_no: 3, reason: "invalid_phone", cells: ["Ana", "12345"] },
      { line_no: 7, reason: "duplicate_in_file", cells: ["=cmd", "11999998888"] },
      { line_no: 9, reason: "empty_phone", cells: null },
    ]);
    expect(csv.startsWith("\u{feff}")).toBe(true);
    const linhas = csv.replace("\u{feff}", "").trim().split("\r\n");
    expect(linhas[0]).toBe(`"Linha","Motivo","Nome","Telefone"`);
    // line_no 3 é a 3ª linha de DADOS = linha 4 na planilha (o cabeçalho é a 1ª).
    expect(linhas[1]).toBe(`"4","Telefone inválido","Ana","12345"`);
    expect(linhas[2]).toBe(`"8","Repetido no arquivo","'=cmd","11999998888"`);
    expect(linhas[3]).toBe(`"10","Telefone vazio"`);
  });
});
