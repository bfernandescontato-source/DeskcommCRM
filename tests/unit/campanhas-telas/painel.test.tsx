import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PainelClient } from "@/app/app/disparos/_components/PainelClient";

import { C1, C2, C3, PAINEL, PODE_GERENTE, PODE_TUDO, renderizar, servidor } from "./apoio";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/app/disparos", useSearchParams: () => new URLSearchParams() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Painel da Central de Disparos", () => {
  it("mostra os sete números do topo, formatados em português", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } } });
    renderizar(<PainelClient pode={PODE_TUDO} />);
    await screen.findByText("BLACK Friday");
    for (const rotulo of ["Em andamento", "Enviados hoje", "Pendentes", "Cliques", "Entradas nos grupos", "Respostas", "Falhas"]) {
      expect(screen.getAllByText(rotulo).length, rotulo).toBeGreaterThan(0);
    }
    expect(screen.getByText("1.234")).toBeInTheDocument(); // enviados hoje
    expect(screen.getByText("36.580")).toBeInTheDocument(); // pendentes
    expect(screen.getByText("1 pausada")).toBeInTheDocument();
  });

  it("cada campanha ativa traz PAUSAR/RETOMAR, EDITAR MENSAGEM, TROCAR GRUPO e VER CAMPANHA", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } } });
    renderizar(<PainelClient pode={PODE_TUDO} />);
    const cartao = (await screen.findByText("BLACK Friday", { selector: "a" })).closest("article")!;
    expect(within(cartao).getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
    expect(within(cartao).getByRole("link", { name: "Editar mensagem" })).toHaveAttribute("href", `/app/disparos/${C1}?aba=mensagens&editar=1`);
    expect(within(cartao).getByRole("link", { name: "Trocar grupo" })).toHaveAttribute("href", `/app/disparos/${C1}?aba=destinos`);
    expect(within(cartao).getByRole("link", { name: "Ver campanha" })).toHaveAttribute("href", `/app/disparos/${C1}`);
    const pausada = screen.getByText("Campanha pausada", { selector: "a" }).closest("article")!;
    expect(within(pausada).getByRole("button", { name: /Retomar/ })).toBeInTheDocument();
  });

  it("o alerta de capacidade aparece com o botão que resolve — a troca é do operador, não automática", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } } });
    renderizar(<PainelClient pode={PODE_TUDO} />);
    await screen.findByText(/BLACK #04 está com 92% da capacidade/);
    const alerta = screen.getByText(/BLACK #04 está com 92% da capacidade/).closest("li")!;
    expect(within(alerta).getByRole("link", { name: "Trocar grupo" })).toHaveAttribute("href", `/app/disparos/${C1}?aba=destinos`);
  });

  it("PAUSAR chama a transição certa; RETOMAR também — sem pedir confirmação", async () => {
    const s = servidor({
      "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } },
      [`POST /api/v1/campaigns/${C1}/transition`]: { corpo: { data: { changed: true, from: "running", to: "paused" } } },
      [`POST /api/v1/campaigns/${C2}/transition`]: { corpo: { data: { changed: true, from: "paused", to: "running" } } },
    });
    renderizar(<PainelClient pode={PODE_GERENTE} />);
    const u = userEvent.setup();
    const cartao = (await screen.findByText("BLACK Friday", { selector: "a" })).closest("article")!;
    await u.click(within(cartao).getByRole("button", { name: /Pausar/ }));
    await waitFor(() => expect(s.feitas("POST", `/api/v1/campaigns/${C1}/transition`)).toHaveLength(1));
    expect(s.feitas("POST", `/api/v1/campaigns/${C1}/transition`)[0]!.corpo).toEqual({ action: "pause" });
    const pausada = screen.getByText("Campanha pausada", { selector: "a" }).closest("article")!;
    await u.click(within(pausada).getByRole("button", { name: /Retomar/ }));
    await waitFor(() => expect(s.feitas("POST", `/api/v1/campaigns/${C2}/transition`)[0]?.corpo).toEqual({ action: "resume" }));
  });

  it("rascunho fica em 'Outras campanhas' e leva de volta ao assistente, no mesmo rascunho", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } } });
    renderizar(<PainelClient pode={PODE_TUDO} />);
    const link = await screen.findByRole("link", { name: "Meu rascunho" });
    expect(link).toHaveAttribute("href", `/app/disparos/nova?id=${C3}`);
  });

  it("sem permissão de criar, não há botão de nova campanha nem de pausar", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } } });
    renderizar(<PainelClient pode={{ ...PODE_TUDO, criar: false, pausar: false, editar: false }} />);
    await screen.findByText("BLACK Friday");
    expect(screen.queryByRole("link", { name: /Nova campanha/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Pausar/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Editar mensagem" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Ver campanha" }).length).toBeGreaterThan(0);
  });

  it("erro do servidor mostra a frase que ele mandou e permite tentar de novo", async () => {
    const s = servidor({ "GET /api/v1/campaigns/dashboard": { status: 500, corpo: { error: { code: "internal", message: "Erro inesperado. Tente novamente." } } } });
    renderizar(<PainelClient pode={PODE_TUDO} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Erro inesperado. Tente novamente.");
    const antes = s.chamadas.length;
    await userEvent.setup().click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(s.chamadas.length).toBeGreaterThan(antes));
  });

  it("sem nenhuma campanha, convida a criar a primeira", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: { panel: { running: 0, paused: 0, sent_today: 0, active: {} }, campaigns: [], alerts: [] } } } });
    renderizar(<PainelClient pode={PODE_TUDO} />);
    expect(await screen.findByText("Nenhuma campanha em andamento")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Criar campanha" })).toHaveAttribute("href", "/app/disparos/nova");
  });
});
