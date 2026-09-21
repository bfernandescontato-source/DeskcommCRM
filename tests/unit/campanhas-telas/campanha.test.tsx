import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampanhaClient } from "@/app/app/disparos/_components/CampanhaClient";

import { C1, PODE_GERENTE, PODE_TUDO, campanha, renderizar, servidor, visao } from "./apoio";

const nav = vi.hoisted(() => ({ aba: "visao" as string | null, status: null as string | null, editar: null as string | null, replace: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => `/app/disparos/${"c1000000-0000-4000-8000-000000000001"}`,
  useSearchParams: () => {
    const p = new URLSearchParams();
    if (nav.aba) p.set("aba", nav.aba);
    if (nav.status) p.set("status", nav.status);
    if (nav.editar) p.set("editar", nav.editar);
    return p;
  },
}));

const OVERVIEW = `GET /api/v1/campaigns/${C1}/overview`;
const TRANSICAO = `POST /api/v1/campaigns/${C1}/transition`;

beforeEach(() => {
  nav.aba = "visao";
  nav.status = null;
  nav.editar = null;
  nav.replace.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Página da campanha — Visão geral", () => {
  it("mostra o bloco Agora, o funil e as métricas por versão, grupo e número", async () => {
    servidor({ [OVERVIEW]: { corpo: { data: visao() } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await screen.findByRole("heading", { name: "BLACK Friday" });

    const agora = screen.getByRole("heading", { name: "Agora" }).closest("section")!;
    expect(within(agora).getByText(/Maria Silva/)).toBeInTheDocument();
    expect(within(agora).getByText("36.580 contatos")).toBeInTheDocument();
    expect(within(agora).getByText("BLACK #04")).toBeInTheDocument();

    const funil = screen.getByRole("heading", { name: "Funil" }).closest("section")!;
    expect(within(funil).getByText("45.000")).toBeInTheDocument();
    expect(within(funil).getByText("8.420")).toBeInTheDocument();
    expect(within(funil).getByText("2.184")).toBeInTheDocument();
    // Grupo sem ID no CRM: entradas e saídas NÃO são medidas — nunca aparecem como zero.
    expect(within(funil).getAllByText("não medido").length).toBeGreaterThanOrEqual(3);
    expect(within(funil).getByText(/Um clique não prova que a pessoa entrou/)).toBeInTheDocument();

    const porVersao = screen.getByRole("heading", { name: "Por versão da mensagem" }).closest("section")!;
    expect(within(porVersao).getByText(/1\.184 · 34,6%/)).toBeInTheDocument(); // V2: 1184 de 3420
    expect(within(porVersao).getByText("ativa")).toBeInTheDocument();

    const numeros = document.getElementById("numeros")!;
    expect(within(numeros).getByText("Número 02")).toBeInTheDocument();
    expect(within(numeros).getByText(/Aguardando: aguardando o intervalo entre envios/)).toBeInTheDocument();
  });

  it("com o grupo monitorado (ID do grupo cadastrado), o funil mostra números, não 'não medido'", async () => {
    const v = visao();
    (v.destinations as Array<{ group_chat_id: string | null }>).forEach((d) => (d.group_chat_id = "1203630000000@g.us"));
    (v.counts as { joined: number }).joined = 1731;
    (v.counts as { left: number }).left = 146;
    servidor({ [OVERVIEW]: { corpo: { data: v } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const funil = (await screen.findByRole("heading", { name: "Funil" })).closest("section")!;
    expect(within(funil).getByText("1.731")).toBeInTheDocument();
    expect(within(funil).getByText("146")).toBeInTheDocument();
    expect(within(funil).getByText("1.585")).toBeInTheDocument(); // permanecem
    expect(within(funil).queryByText("não medido")).toBeNull();
  });

  it("admin vê PAUSAR e ENCERRAR; manager só PAUSAR — e ENCERRAR explica a diferença antes de agir", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [TRANSICAO]: { corpo: { data: { changed: true, from: "running", to: "completed", cancelled_contacts: 36580 } } },
    });
    const { unmount } = renderizar(<CampanhaClient id={C1} pode={PODE_GERENTE} />);
    await screen.findByRole("heading", { name: "BLACK Friday" });
    expect(screen.getByRole("button", { name: "Pausar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Encerrar" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Iniciar/ })).toBeNull();
    unmount();

    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Encerrar" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText(/termina a campanha de vez/)).toBeInTheDocument();
    expect(within(dialogo).getByText(/use Pausar/)).toBeInTheDocument();
    expect(s.feitas("POST", `/api/v1/campaigns/${C1}/transition`)).toHaveLength(0); // ainda não agiu
    await u.click(within(dialogo).getByRole("button", { name: "Encerrar" }));
    await waitFor(() => expect(s.feitas("POST", `/api/v1/campaigns/${C1}/transition`)[0]?.corpo).toEqual({ action: "complete" }));
  });

  it("campanha pausada por queda de número diz o motivo e oferece Retomar", async () => {
    const v = visao();
    Object.assign(v.campaign, { status: "paused", status_reason: "channel_down" });
    servidor({ [OVERVIEW]: { corpo: { data: v } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    expect(await screen.findByText(/um número caiu\. A fila continua exatamente de onde parou/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retomar" })).toBeInTheDocument();
  });

  it("rascunho mostra 'Continuar configuração' e Iniciar pede confirmação com o aviso de irreversível", async () => {
    const v = visao();
    Object.assign(v.campaign, { status: "draft" });
    servidor({ [OVERVIEW]: { corpo: { data: v } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    expect(await screen.findByRole("link", { name: "Continuar configuração" })).toHaveAttribute("href", `/app/disparos/nova?id=${C1}`);
    await userEvent.setup().click(screen.getByRole("button", { name: "Iniciar campanha" }));
    expect(await screen.findByText(/Um envio não pode ser desfeito/)).toBeInTheDocument();
  });

  it("os alertas da campanha aparecem no topo, com o botão para a aba certa", async () => {
    servidor({
      [OVERVIEW]: { corpo: { data: visao({ alerts: [{ level: "critical", code: "campaign_paused", message: "Campanha pausada: nenhum número está conectado.", action: "edit_channels" }] }) } },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const alerta = (await screen.findByText(/nenhum número está conectado/)).closest("li")!;
    expect(within(alerta).getByRole("link", { name: "Ver números" })).toHaveAttribute("href", `/app/disparos/${C1}?aba=visao#numeros`);
  });

  it("trocar de aba muda a URL (a aba sobrevive a um F5) sem rolar a página", async () => {
    servidor({ [OVERVIEW]: { corpo: { data: visao() } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Fila" }));
    expect(nav.replace).toHaveBeenCalledWith(`/app/disparos/${C1}?aba=fila`, { scroll: false });
  });

  it("campanha que não existe mostra o erro do servidor e um caminho de volta", async () => {
    servidor({ [OVERVIEW]: { status: 404, corpo: { error: { code: "campaign_not_found", message: "Campanha não encontrada." } } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Campanha não encontrada.");
    expect(screen.getByRole("link", { name: /Disparos/ })).toHaveAttribute("href", "/app/disparos");
  });
});

void campanha;
