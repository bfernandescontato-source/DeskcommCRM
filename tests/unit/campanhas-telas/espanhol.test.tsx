import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampanhaClient } from "@/app/app/disparos/_components/CampanhaClient";
import { PainelClient } from "@/app/app/disparos/_components/PainelClient";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { traduzir } from "@/lib/i18n/dicionario";

import { C1, PAINEL, PODE_TUDO, renderizar, servidor, visao } from "./apoio";

const nav = vi.hoisted(() => ({ aba: "visao" as string }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/disparos/x",
  useSearchParams: () => new URLSearchParams({ aba: nav.aba }),
}));

beforeEach(() => {
  nav.aba = "visao";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Central de Disparos em espanhol", () => {
  it("o painel inteiro sai em espanhol: números, botões e alertas de estado — e nada de português vazando", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } } });
    renderizar(
      <IdiomaProvider locale="es">
        <PainelClient pode={PODE_TUDO} />
      </IdiomaProvider>,
    );
    await screen.findByText("BLACK Friday");
    // Os rótulos que já existiam no dicionário do produto vêm de lá (não os reescrevi); os novos, da Central.
    for (const pt of ["Em andamento", "Enviados hoje", "Pendentes", "Cliques", "Entradas nos grupos", "Respostas", "Falhas", "Campanhas ativas", "Nova campanha", "Outras campanhas"]) {
      const es = traduzir(pt, "es");
      expect(screen.getAllByText(es).length, `${pt} → ${es}`).toBeGreaterThan(0);
    }
    expect(screen.getAllByText("Enviados hoy").length).toBeGreaterThan(0);
    const cartao = screen.getByText("BLACK Friday", { selector: "a" }).closest("article")!;
    expect(within(cartao).getByText("8.420 de 45.000 enviados · 18,7%")).toBeInTheDocument();
    expect(within(cartao).getByRole("button", { name: /Pausar/ })).toBeInTheDocument();
    expect(within(cartao).getByRole("link", { name: "Editar mensaje" })).toBeInTheDocument();
    expect(within(cartao).getByRole("link", { name: "Cambiar grupo" })).toBeInTheDocument();
    expect(within(cartao).getByRole("link", { name: "Ver campaña" })).toBeInTheDocument();
    expect(screen.queryByText("Campanhas ativas")).toBeNull();
    expect(screen.queryByText("Enviados hoje")).toBeNull();
  });

  it("a página da campanha: 'Agora', o funil e as frases compostas com o marcador preenchido no idioma certo", async () => {
    servidor({ [`GET /api/v1/campaigns/${C1}/overview`]: { corpo: { data: visao() } } });
    renderizar(
      <IdiomaProvider locale="es">
        <CampanhaClient id={C1} pode={PODE_TUDO} />
      </IdiomaProvider>,
    );
    await screen.findByRole("heading", { name: "BLACK Friday" });
    const agora = screen.getByRole("heading", { name: "Ahora" }).closest("section")!;
    expect(within(agora).getByText("Quedan en la cola")).toBeInTheDocument();
    expect(within(agora).getByText("36.580 contactos")).toBeInTheDocument();
    const funil = screen.getByRole("heading", { name: traduzir("Funil", "es") }).closest("section")!;
    expect(within(funil).getAllByText("no medido").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("tab", { name: traduzir("Visão geral", "es") })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Visão geral" })).toBeNull();
  });
});
