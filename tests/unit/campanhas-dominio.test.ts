import { describe, expect, it } from "vitest";

import { erroDaCampanha } from "@/lib/campaigns/erros";
import {
  chaveDeVariavel,
  chavesSoltas,
  renderizarMensagem,
  variaveisDaMensagem,
} from "@/lib/campaigns/mensagem";
import { PAPEL_MINIMO, papelMinimo } from "@/lib/campaigns/permissoes";
import {
  ACOES_DA_API,
  atualizarCampanhaSchema,
  criarCampanhaSchema,
  destinoSchema,
  eventosQuerySchema,
  transicaoSchema,
  versaoSchema,
  conviteValido,
} from "@/lib/campaigns/schemas";
import { codificarCursorDeEventos, decodificarCursorDeEventos } from "@/lib/campaigns/service";
import { CAMPAIGN_ACTIONS } from "@/lib/campaigns/vocabulario";

describe("mensagem — variáveis", () => {
  it("lista as variáveis usadas, sem repetir, em minúsculas e na ordem", () => {
    expect(variaveisDaMensagem("Oi {{Nome}}! {{ produto }} e {{nome}}. Entre: {{link_grupo}}")).toEqual([
      "nome",
      "produto",
      "link_grupo",
    ]);
    expect(variaveisDaMensagem("sem variável")).toEqual([]);
  });

  it("resolve nome, primeiro nome, link do grupo e colunas extras do CSV", () => {
    const r = renderizarMensagem("Oi {{primeiro_nome}} ({{nome}}), veja {{produto}}: {{link_grupo}}", {
      nome: "Maria Silva",
      linkGrupo: "https://crm.exemplo/g/abc123",
      variaveis: { produto: "Tênis" },
    });
    expect(r.texto).toBe("Oi Maria (Maria Silva), veja Tênis: https://crm.exemplo/g/abc123");
    expect(r.faltando).toEqual([]);
  });

  it("variável sem valor NÃO vira texto enviável: devolve o que faltou", () => {
    const r = renderizarMensagem("Oi {{nome}}, {{produto}} e {{cidade}}", { nome: "Ana", variaveis: { produto: "  " } });
    expect(r.faltando).toEqual(["produto", "cidade"]);
    // O literal fica no texto de propósito: quem chama vê que NÃO pode enviar.
    expect(r.texto).toContain("{{produto}}");
  });

  it("identificador técnico e nome vazio contam como sem nome", () => {
    expect(renderizarMensagem("Oi {{nome}}", { nome: "543134@lid" }).faltando).toEqual(["nome"]);
    expect(renderizarMensagem("Oi {{primeiro_nome}}", { nome: "   " }).faltando).toEqual(["primeiro_nome"]);
    expect(renderizarMensagem("Oi {{nome}}", { nome: null }).faltando).toEqual(["nome"]);
  });

  it("o link do grupo vem do contexto, nunca do texto: trocar o destino não edita a mensagem", () => {
    const corpo = "Entre: {{link_grupo}}";
    const a = renderizarMensagem(corpo, { linkGrupo: "https://chat.whatsapp.com/BLACK01" });
    const b = renderizarMensagem(corpo, { linkGrupo: "https://chat.whatsapp.com/BLACK02" });
    expect(a.texto).toBe("Entre: https://chat.whatsapp.com/BLACK01");
    expect(b.texto).toBe("Entre: https://chat.whatsapp.com/BLACK02");
    expect(renderizarMensagem(corpo, {}).faltando).toEqual(["link_grupo"]);
  });

  it("detecta chave solta ({{nome} , {nome}}, espaço dentro do nome)", () => {
    expect(chavesSoltas("Oi {{nome}}")).toBe(false);
    expect(chavesSoltas("Oi {{nome}")).toBe(true);
    expect(chavesSoltas("Oi {nome}}")).toBe(true);
    expect(chavesSoltas("Oi {{primeiro nome}}")).toBe(true);
  });

  it("normaliza o cabeçalho do CSV para chave de variável", () => {
    expect(chaveDeVariavel("Produto Comprado")).toBe("produto_comprado");
    expect(chaveDeVariavel("  Cidade/UF ")).toBe("cidade_uf");
    expect(chaveDeVariavel("Preço (R$)")).toBe("preco_r");
  });
});

describe("schemas — entrada da API", () => {
  it("recusa campo desconhecido: a organização nunca vem do corpo", () => {
    expect(criarCampanhaSchema.safeParse({ name: "Black", organization_id: "x" }).success).toBe(false);
    expect(criarCampanhaSchema.safeParse({ name: "Black" }).success).toBe(true);
    expect(criarCampanhaSchema.parse({ name: " Black " })).toMatchObject({ name: "Black", tracking_enabled: true, channel_policy: "skip_channel" });
    expect(criarCampanhaSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("atualizar exige ao menos um campo", () => {
    expect(atualizarCampanhaSchema.safeParse({}).success).toBe(false);
    expect(atualizarCampanhaSchema.safeParse({ tracking_enabled: false }).success).toBe(true);
  });

  it("a API só expõe ações que uma pessoa pode pedir (fail é do sistema)", () => {
    expect([...ACOES_DA_API]).not.toContain("fail");
    for (const a of ACOES_DA_API) expect(CAMPAIGN_ACTIONS).toContain(a);
    expect(transicaoSchema.safeParse({ action: "fail" }).success).toBe(false);
    expect(transicaoSchema.safeParse({ action: "pause", reason: "almoço" }).success).toBe(true);
  });

  it("só aceita convite de https do WhatsApp, sem credencial embutida", () => {
    expect(conviteValido("https://chat.whatsapp.com/AbCdEf123456")).toBe(true);
    expect(conviteValido("https://whatsapp.com/channel/0029VaAbCdEf")).toBe(true);
    expect(conviteValido("https://wa.me/5511999999999")).toBe(false); // click-to-chat, não é grupo
    expect(conviteValido("http://chat.whatsapp.com/AbCdEf123456")).toBe(false);
    expect(conviteValido("javascript:alert(1)")).toBe(false);
    expect(conviteValido("https://evil.example/chat.whatsapp.com/AbCd")).toBe(false);
    expect(conviteValido("https://chat.whatsapp.com@evil.example/AbCd")).toBe(false);
    expect(conviteValido("https://user:pass@chat.whatsapp.com/AbCd")).toBe(false);
    expect(conviteValido("https://chat.whatsapp.com/")).toBe(false);
    expect(conviteValido("https://chat.whatsapp.com/ab cd")).toBe(false);
    expect(conviteValido("https://chat.whatsapp.com.evil.example/AbCd")).toBe(false);
  });

  it("destino: capacidade e id do grupo têm formato", () => {
    const base = { name: "BLACK #04", invite_url: "https://chat.whatsapp.com/AbCdEf123456" };
    expect(destinoSchema.safeParse({ ...base, capacity: 950, group_chat_id: "120363025@g.us" }).success).toBe(true);
    expect(destinoSchema.safeParse({ ...base, capacity: 0 }).success).toBe(false);
    expect(destinoSchema.safeParse({ ...base, group_chat_id: "abc@c.us" }).success).toBe(false);
    expect(destinoSchema.parse(base)).toMatchObject({ activate: false, close_reason: "full" });
  });

  it("versão: activate padrão é true e o texto tem teto do WhatsApp", () => {
    expect(versaoSchema.parse({ body: "Oi" })).toMatchObject({ activate: true });
    expect(versaoSchema.safeParse({ body: "x".repeat(4097) }).success).toBe(false);
    expect(versaoSchema.safeParse({ body: "" }).success).toBe(false);
  });

  it("eventos: limite tem teto e o contato é um UUID", () => {
    expect(eventosQuerySchema.parse({}).limit).toBe(30);
    expect(eventosQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(eventosQuerySchema.safeParse({ contact: "não-é-uuid" }).success).toBe(false);
  });
});

describe("permissões", () => {
  it("iniciar, encerrar e cancelar são do admin; pausar e retomar ficam com quem opera", () => {
    expect(papelMinimo("start")).toBe("admin");
    expect(papelMinimo("complete")).toBe("admin");
    expect(papelMinimo("cancel")).toBe("admin");
    expect(papelMinimo("pause")).toBe("manager");
    expect(papelMinimo("resume")).toBe("manager");
    expect(papelMinimo("editar_mensagem")).toBe("manager");
    expect(papelMinimo("trocar_destino")).toBe("manager");
    expect(papelMinimo("ler")).toBe("manager");
  });

  it("toda ação da API tem papel definido", () => {
    for (const a of ACOES_DA_API) expect(PAPEL_MINIMO[a]).toBeDefined();
  });
});

describe("erros do banco -> erros da API", () => {
  it("cada regra do banco vira um código estável e um status", () => {
    expect(erroDaCampanha({ message: "campaign_not_found" })).toMatchObject({ code: "campaign_not_found", status: 404 });
    expect(erroDaCampanha({ message: "campaign_closed" })).toMatchObject({ status: 409 });
    expect(erroDaCampanha({ message: "campaign_invalid_transition", details: "cancelled -> running" })).toMatchObject({
      code: "invalid_transition",
      status: 409,
      details: { from: "cancelled", to: "running" },
    });
  });

  it("o que falta para iniciar diz QUAL passo do assistente refazer", () => {
    expect(erroDaCampanha({ message: "campaign_no_contacts" }).details).toEqual({ missing: "contacts" });
    expect(erroDaCampanha({ message: "campaign_no_message" }).details).toEqual({ missing: "message" });
    expect(erroDaCampanha({ message: "campaign_no_destination" }).details).toEqual({ missing: "destination" });
    expect(erroDaCampanha({ message: "campaign_no_channel" }).details).toEqual({ missing: "channel" });
    expect(erroDaCampanha({ message: "campaign_no_channel" })).toMatchObject({ code: "campaign_incomplete", status: 422 });
  });

  it("conflito de versão devolve a versão atual para a tela recarregar", () => {
    expect(erroDaCampanha({ message: "campaign_version_conflict", details: "current=4" })).toMatchObject({
      code: "version_conflict",
      status: 409,
      details: { current_version_no: 4 },
    });
    expect(erroDaCampanha({ message: "campaign_destination_conflict" })).toMatchObject({ code: "destination_conflict", status: 409 });
  });

  it("check_violation vira 422; erro desconhecido vira 500 SEM vazar a mensagem interna", () => {
    expect(erroDaCampanha({ message: "new row violates check constraint", code: "23514" })).toMatchObject({ status: 422 });
    const desconhecido = erroDaCampanha({ message: "connection refused to 10.0.0.5:5432", code: "08006" });
    expect(desconhecido.status).toBe(500);
    expect(JSON.stringify(desconhecido)).not.toContain("10.0.0.5");
  });
});

describe("cursor da linha do tempo", () => {
  const ok = { t: "2026-09-21T16:13:03.415123+00:00", id: "6261acd7-1dfa-4250-b47f-36439ec42171" };

  it("ida e volta", () => {
    expect(decodificarCursorDeEventos(codificarCursorDeEventos(ok))).toEqual(ok);
  });

  it("recusa tudo que não tenha exatamente a forma esperada (o cursor vira filtro do PostgREST)", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    expect(decodificarCursorDeEventos("lixo")).toBeNull();
    expect(decodificarCursorDeEventos(enc({ t: ok.t }))).toBeNull();
    expect(decodificarCursorDeEventos(enc({ ...ok, id: "x),id.gt.0" }))).toBeNull();
    expect(decodificarCursorDeEventos(enc({ ...ok, t: "2026-09-21T16:13:03Z),or(id.gt.0" }))).toBeNull();
    expect(decodificarCursorDeEventos(enc({ ...ok, t: "ontem" }))).toBeNull();
  });
});

import { permissoesDaCentral } from "@/lib/campaigns/permissoes";

describe("o que a tela oferece por papel", () => {
  it("viewer e agent não veem a Central; manager opera; só admin inicia e encerra", () => {
    expect(permissoesDaCentral("viewer")).toEqual({ ver: false, criar: false, editar: false, pausar: false, iniciar: false, encerrar: false, resolverIncerto: false });
    expect(permissoesDaCentral("agent").criar).toBe(false);
    expect(permissoesDaCentral("manager")).toEqual({ ver: true, criar: true, editar: true, pausar: true, iniciar: false, encerrar: false, resolverIncerto: true });
    expect(permissoesDaCentral("admin")).toEqual({ ver: true, criar: true, editar: true, pausar: true, iniciar: true, encerrar: true, resolverIncerto: true });
    expect(permissoesDaCentral(null).criar).toBe(false);
    expect(permissoesDaCentral("papel-inventado").criar).toBe(false);
  });
});
