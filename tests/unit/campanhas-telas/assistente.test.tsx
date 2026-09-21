import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Assistente } from "@/app/app/disparos/_components/Assistente";

import { C1, PODE_GERENTE, PODE_TUDO, renderizar, servidor, visao } from "./apoio";

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => "/app/disparos/nova",
  useSearchParams: () => nav.params,
}));

const BASE = `/api/v1/campaigns/${C1}`;
const OVERVIEW = `GET ${BASE}/overview`;
const IMP = "11110000-0000-4000-8000-000000000001";

/** Uma campanha ainda rascunho, sem nada configurado. */
function rascunho(extra: Record<string, unknown> = {}) {
  const v = visao();
  Object.assign(v.campaign, { status: "draft", active_version_id: null, active_destination_id: null, started_at: null });
  Object.assign(v.counts, { total: 0, pending: 0, sent: 0, failed: 0, clicked: 0, replied: 0, processing: 0 });
  Object.assign(v, { versions: [], destinations: [], channels: [], ...extra });
  return v;
}

beforeEach(() => {
  nav.params = new URLSearchParams();
  nav.replace.mockClear();
  nav.push.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Assistente — começo", () => {
  it("sem campanha só pede o nome; ao criar, o rascunho vai para a URL (é o que faz o F5 retomar)", async () => {
    const s = servidor({ "POST /api/v1/campaigns": { status: 201, corpo: { data: { id: C1 } } } });
    renderizar(<Assistente pode={PODE_TUDO} />);
    const u = userEvent.setup();
    const botao = screen.getByRole("button", { name: "Criar e continuar" });
    expect(botao).toBeDisabled();
    await u.type(screen.getByLabelText("Nome da campanha"), "  Black Friday 2026 ");
    await u.click(botao);
    await waitFor(() => expect(s.feitas("POST", "/api/v1/campaigns")).toHaveLength(1));
    expect(s.feitas("POST", "/api/v1/campaigns")[0]!.corpo).toEqual({ name: "Black Friday 2026" });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(`/app/disparos/nova?id=${C1}&passo=contatos`, { scroll: false }));
  });

  it("campanha já iniciada não abre o assistente: leva para a página dela", async () => {
    nav.params = new URLSearchParams({ id: C1 });
    servidor({ [OVERVIEW]: { corpo: { data: visao() } } });
    renderizar(<Assistente pode={PODE_TUDO} />);
    expect(await screen.findByText(/já foi iniciada e não é mais editada por aqui/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir a campanha" })).toHaveAttribute("href", `/app/disparos/${C1}`);
  });

  it("mostra os cinco passos, marca o atual e o que já está pronto", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "mensagem" });
    servidor({ [OVERVIEW]: { corpo: { data: rascunho() } } });
    renderizar(<Assistente pode={PODE_TUDO} />);
    const passos = await screen.findByRole("navigation", { name: "Passos" });
    expect(within(passos).getAllByRole("button").map((b) => b.textContent?.replace(/^\d/, ""))).toEqual(["Contatos", "Mensagem", "Destino", "Envio", "Revisão"]);
    expect(within(passos).getByRole("button", { name: /Mensagem/ })).toHaveAttribute("aria-current", "step");
  });
});

describe("Passo 1 — importação do CSV, retomável", () => {
  beforeEach(() => {
    nav.params = new URLSearchParams({ id: C1, passo: "contatos" });
  });

  it("envia o arquivo e guarda o id da importação na URL", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: rascunho() } },
      [`POST ${BASE}/imports`]: { status: 201, corpo: { data: { import_id: IMP, filename: "lista.csv", total_rows: 3, headers: ["Nome", "Telefone"], sample: [], suggested_mapping: { phone: 1, name: 0, email: null, extras: [] } } } },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    await screen.findByText("Arraste o arquivo CSV aqui");
    const arquivo = new File(["Nome,Telefone\nAna,11999990000\n"], "lista.csv", { type: "text/csv" });
    await userEvent.setup().upload(screen.getByLabelText("Arquivo CSV"), arquivo);
    await waitFor(() => expect(s.feitas("POST", `${BASE}/imports`)[0]?.corpo).toEqual({ arquivo: "lista.csv" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(`/app/disparos/nova?id=${C1}&passo=contatos&imp=${IMP}`, { scroll: false }));
  });

  it("depois de um F5 no meio do mapeamento, a prévia e a sugestão voltam do servidor", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "contatos", imp: IMP });
    servidor({
      [OVERVIEW]: { corpo: { data: rascunho() } },
      [`GET ${BASE}/imports/${IMP}`]: {
        corpo: {
          data: {
            import_id: IMP, campaign_id: C1, status: "uploaded", filename: "lista.csv", total_rows: 45000, headers: ["Nome", "Telefone", "Cidade"],
            mapping: null, found: 45000, raw: 45000, valid: 0, imported: 0, rejected: 0, existing_contacts: 0, new_contacts: 0, by_reason: {},
            sample: [["Ana", "11999990000", "Campinas"]],
            suggested_mapping: { phone: 1, name: 0, email: null, extras: [{ key: "cidade", index: 2, label: "Cidade" }] },
          },
        },
      },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    expect(await screen.findByText("Confira as colunas de lista.csv")).toBeInTheDocument();
    expect(screen.getByText(/45\.000 linhas encontradas/)).toBeInTheDocument();
    expect(screen.getByText("Campinas")).toBeInTheDocument();
    expect(screen.getByLabelText("Coluna do telefone")).toHaveValue("1");
    expect(screen.getByLabelText("Coluna do nome")).toHaveValue("0");
    expect(screen.getByLabelText(/Cidade/)).toBeChecked();
  });

  it("do mapeamento ao fim: confere, mostra válidos/recusados/duplicados, baixa os recusados e importa em lotes com progresso", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "contatos", imp: IMP });
    // O servidor guarda o estado; a tela só o lê. O teste espelha isso com uma variável.
    const importacao = {
      import_id: IMP, campaign_id: C1, status: "uploaded", filename: "lista.csv", total_rows: 45000, headers: ["Nome", "Telefone", "Cidade"],
      mapping: null as unknown, found: 45000, raw: 45000, valid: 0, imported: 0, rejected: 0, existing_contacts: 0, new_contacts: 0, by_reason: {} as Record<string, number>,
    };
    const lotes = [{ processed: 30000, remaining: 14732, status: "importing" }, { processed: 14732, remaining: 0, status: "done" }];
    let lote = 0;
    const s = servidor({
      [OVERVIEW]: { corpo: { data: rascunho() } },
      [`GET ${BASE}/imports/${IMP}`]: () => ({
        corpo: { data: importacao.status === "uploaded" ? { ...importacao, sample: [["Ana", "11999990000", "Campinas"]], suggested_mapping: { phone: 1, name: 0, email: null, extras: [{ key: "cidade", index: 2, label: "Cidade" }] } } : importacao },
      }),
      [`POST ${BASE}/imports/${IMP}/validate`]: () => {
        Object.assign(importacao, { status: "validated", valid: 44732, rejected: 268, existing_contacts: 1200, new_contacts: 43532, by_reason: { invalid_phone: 200, duplicate_in_file: 68 } });
        return { corpo: { data: importacao } };
      },
      [`POST ${BASE}/imports/${IMP}/commit`]: () => {
        const r = lotes[lote++]!;
        Object.assign(importacao, { status: r.status, imported: importacao.imported + r.processed, valid: importacao.valid - r.processed });
        return { corpo: { data: r } };
      },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    const u = userEvent.setup();

    await u.click(await screen.findByRole("button", { name: "Conferir arquivo" }));
    await waitFor(() => expect(s.feitas("POST", `${BASE}/imports/${IMP}/validate`)).toHaveLength(1));
    expect(s.feitas("POST", `${BASE}/imports/${IMP}/validate`)[0]!.corpo).toEqual({ phone: 1, name: 0, email: null, extras: [{ key: "cidade", index: 2 }] });

    // Nada foi importado ainda: o resultado da conferência vem primeiro.
    expect(await screen.findByText("Resultado da conferência de lista.csv")).toBeInTheDocument();
    expect(screen.getByText("44.732")).toBeInTheDocument();
    expect(screen.getByText("43.532")).toBeInTheDocument();
    expect(screen.getByText("1.200")).toBeInTheDocument();
    expect(screen.getByText("Telefone inválido")).toBeInTheDocument();
    expect(screen.getByText("Repetido no arquivo")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Baixar os recusados/ })).toHaveAttribute("href", `${BASE}/imports/${IMP}/rejects?format=csv`);
    expect(s.feitas("POST", `${BASE}/imports/${IMP}/commit`)).toHaveLength(0);

    await u.click(screen.getByRole("button", { name: "Importar 44.732 contatos" }));
    await waitFor(() => expect(s.feitas("POST", `${BASE}/imports/${IMP}/commit`)).toHaveLength(2));
    // Terminou: a tela volta a oferecer outro arquivo e diz quantos entraram.
    expect(await screen.findByText(/Pronto: 44\.732 contatos importados de lista\.csv/)).toBeInTheDocument();
  });

  it("recarregou no meio da importação: continua sozinho de onde parou (o banco sabe quantos faltam)", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "contatos", imp: IMP });
    const st = { status: "importing", imported: 30000, valid: 14732 };
    const s = servidor({
      [OVERVIEW]: { corpo: { data: rascunho() } },
      [`GET ${BASE}/imports/${IMP}`]: () => ({ corpo: { data: { import_id: IMP, campaign_id: C1, filename: "lista.csv", total_rows: 45000, headers: ["Nome", "Telefone"], mapping: {}, found: 45000, raw: 0, rejected: 268, existing_contacts: 0, new_contacts: 0, by_reason: {}, ...st } } }),
      [`POST ${BASE}/imports/${IMP}/commit`]: () => {
        Object.assign(st, { status: "done", imported: 44732, valid: 0 });
        return { corpo: { data: { processed: 14732, remaining: 0, status: "done" } } };
      },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    await waitFor(() => expect(s.feitas("POST", `${BASE}/imports/${IMP}/commit`)).toHaveLength(1));
    expect(await screen.findByText(/Pronto: 44\.732 contatos importados/)).toBeInTheDocument();
  });

  it("se a importação falha no meio, NÃO tenta de novo em laço: mostra o erro e espera a pessoa clicar em continuar", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "contatos", imp: IMP });
    const s = servidor({
      [OVERVIEW]: { corpo: { data: rascunho() } },
      [`GET ${BASE}/imports/${IMP}`]: { corpo: { data: { import_id: IMP, campaign_id: C1, status: "importing", filename: "lista.csv", total_rows: 10, headers: ["Nome", "Telefone"], mapping: {}, found: 10, raw: 0, valid: 5, imported: 5, rejected: 0, existing_contacts: 0, new_contacts: 0, by_reason: {} } } },
      [`POST ${BASE}/imports/${IMP}/commit`]: { status: 500, corpo: { error: { code: "internal", message: "Erro inesperado." } } },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    const botao = await screen.findByRole("button", { name: "Continuar importação" });
    // Dá vários turnos ao navegador (macrotarefas): um laço de retentativa, se existisse, apareceria aqui.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 15));
    expect(s.feitas("POST", `${BASE}/imports/${IMP}/commit`)).toHaveLength(1); // uma tentativa, não um laço
    expect(botao).toBeEnabled();
  });

  it("descartar o arquivo apaga a importação e volta ao começo", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "contatos", imp: IMP });
    const s = servidor({
      [OVERVIEW]: { corpo: { data: rascunho() } },
      [`GET ${BASE}/imports/${IMP}`]: { corpo: { data: { import_id: IMP, campaign_id: C1, status: "uploaded", filename: "x.csv", total_rows: 3, headers: ["Telefone"], mapping: null, found: 3, raw: 3, valid: 0, imported: 0, rejected: 0, existing_contacts: 0, new_contacts: 0, by_reason: {}, sample: [], suggested_mapping: { phone: 0, name: null, email: null, extras: [] } } } },
      [`DELETE ${BASE}/imports/${IMP}`]: { corpo: { data: { changed: true } } },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Descartar arquivo" }));
    await waitFor(() => expect(s.feitas("DELETE", `${BASE}/imports/${IMP}`)).toHaveLength(1));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(`/app/disparos/nova?id=${C1}&passo=contatos`, { scroll: false }));
  });
});

describe("Passos 2–5", () => {
  it("Mensagem: salva a primeira versão já ativa e segue para o Destino", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "mensagem" });
    const s = servidor({
      [OVERVIEW]: { corpo: { data: rascunho() } },
      [`POST ${BASE}/versions`]: { status: 201, corpo: { data: { version_id: "v1", version_no: 1, activated: true, previous_version_no: null } } },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    const u = userEvent.setup();
    const salvar = await screen.findByRole("button", { name: "Salvar mensagem" });
    expect(salvar).toBeDisabled();
    const campo = screen.getByLabelText("Texto da mensagem") as HTMLTextAreaElement;
    await u.click(screen.getByRole("button", { name: "{{primeiro_nome}}" }));
    // O botão de variável insere no lugar do cursor e devolve o cursor para depois dela.
    await waitFor(() => expect(campo.selectionStart).toBe("{{primeiro_nome}}".length));
    await u.keyboard(" entre: ");
    await u.click(screen.getByRole("button", { name: "{{link_grupo}}" }));
    await waitFor(() => expect(campo.value).toBe("{{primeiro_nome}} entre: {{link_grupo}}"));
    expect(screen.getByText(/Como a pessoa vai ver/)).toBeInTheDocument();
    expect(screen.getByText(/cadastre um grupo em Destinos antes de iniciar/)).toBeInTheDocument();
    await u.click(salvar);
    await waitFor(() => expect(s.feitas("POST", `${BASE}/versions`)[0]?.corpo).toEqual({ body: "{{primeiro_nome}} entre: {{link_grupo}}", activate: true, based_on_version_no: 0 }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(`/app/disparos/nova?id=${C1}&passo=destino`, { scroll: false }));
  });

  it("Envio: mostra por quanto tempo a fila vai levar — 300 por dia por número, então semanas (e mais números aceleram)", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "envio" });
    const v = rascunho({ channels: [{ channel_session_id: "s1", enabled: true, session: { id: "s1", display_name: "Número 01", phone_number: "5511999990001", status: "WORKING" } }] });
    Object.assign(v.counts, { total: 45000, pending: 45000 });
    servidor({
      [OVERVIEW]: { corpo: { data: v } },
      "GET /api/v1/channel-sessions": { corpo: { data: [{ id: "s1", display_name: "Número 01", phone_number: "5511999990001", waha_session_name: "n1", status: "WORKING", daily_message_limit: 300 }, { id: "s2", display_name: "Número 02", phone_number: "5511999990002", waha_session_name: "n2", status: "WORKING", daily_message_limit: 300 }], meta: {} } },
    });
    renderizar(<Assistente pode={PODE_TUDO} />);
    expect(await screen.findByText(/300 mensagens por dia/)).toBeInTheDocument();
    expect(screen.getByText(/cerca de 5 meses/)).toBeInTheDocument(); // 45.000 / 300 = 150 dias
    expect(screen.getByText(/O sistema não varia o ritmo/)).toBeInTheDocument();
  });

  it("Revisão: mostra o que falta; manager só deixa 'pronta', admin inicia — e o início vai para a página da campanha", async () => {
    nav.params = new URLSearchParams({ id: C1, passo: "revisao" });
    servidor({ [OVERVIEW]: { corpo: { data: rascunho() } } });
    const { unmount } = renderizar(<Assistente pode={PODE_TUDO} />);
    expect(await screen.findByText("Importe os contatos")).toBeInTheDocument();
    expect(screen.getByText("Escreva a mensagem")).toBeInTheDocument();
    expect(screen.getByText("Escolha ao menos um número")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Iniciar campanha" })).toBeDisabled();
    unmount();
    cleanup();

    const completo = rascunho({ channels: [{ channel_session_id: "s1", enabled: true, session: { id: "s1", display_name: "N1", phone_number: "1", status: "WORKING" } }] });
    Object.assign(completo.campaign, { active_version_id: "v1", active_destination_id: "d4" });
    Object.assign(completo.counts, { total: 100, pending: 100 });
    (completo as { versions: unknown[] }).versions = [{ id: "v1", version_no: 1, body: "Oi {{link_grupo}}", created_by: null, created_by_name: null, created_at: "2026-09-21T12:00:00Z", activated_at: null, superseded_at: null }];
    const s = servidor({
      [OVERVIEW]: { corpo: { data: completo } },
      [`POST ${BASE}/transition`]: { corpo: { data: { changed: true, from: "draft", to: "running" } } },
    });
    renderizar(<Assistente pode={PODE_GERENTE} />);
    expect(await screen.findByRole("button", { name: "Deixar pronta para iniciar" })).toBeEnabled();
    expect(screen.getByText(/Só um administrador inicia o envio/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Iniciar campanha" })).toBeNull();
    cleanup();

    renderizar(<Assistente pode={PODE_TUDO} />);
    const iniciar = await screen.findByRole("button", { name: "Iniciar campanha" });
    expect(iniciar).toBeEnabled();
    fireEvent.click(iniciar);
    await waitFor(() => expect(s.feitas("POST", `${BASE}/transition`)[0]?.corpo).toEqual({ action: "start" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/app/disparos/${C1}`));
  });
});
