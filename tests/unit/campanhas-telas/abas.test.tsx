import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampanhaClient } from "@/app/app/disparos/_components/CampanhaClient";

import { C1, PODE_GERENTE, PODE_TUDO, linhaDaFila, perfil, renderizar, servidor, visao } from "./apoio";

const nav = vi.hoisted(() => ({ aba: "fila" as string, status: null as string | null, editar: null as string | null, replace: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => "/app/disparos/c1000000-0000-4000-8000-000000000001",
  useSearchParams: () => {
    const p = new URLSearchParams({ aba: nav.aba });
    if (nav.status) p.set("status", nav.status);
    if (nav.editar) p.set("editar", nav.editar);
    return p;
  },
}));

const BASE = `/api/v1/campaigns/${C1}`;
const OVERVIEW = `GET ${BASE}/overview`;
const FILA = `GET ${BASE}/contacts`;

beforeEach(() => {
  nav.aba = "fila";
  nav.status = null;
  nav.editar = null;
  vi.mocked(toast.error).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pagina = (linhas: unknown[], cursor: string | null = null) => ({ corpo: { data: linhas, meta: { cursor, has_more: cursor !== null } } });

describe("Fila", () => {
  it("lista os contatos com o estado de cada um — enviado, clicou, respondeu, incerto, falhou", async () => {
    servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [FILA]: pagina([
        linhaDaFila("a", { name: "Ana", status: "sent" }),
        linhaDaFila("b", { name: "Bia", clicked_at: "2026-09-21T15:10:00Z" }),
        linhaDaFila("c", { name: "Caio", clicked_at: "x", replied_at: "y" }),
        linhaDaFila("d", { name: "Duda", status: "uncertain" }),
        linhaDaFila("e", { name: "Edu", status: "failed", last_error_code: "missing_variable" }),
      ]),
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const tabela = (await screen.findByText("Ana")).closest("table")!;
    for (const estado of ["Enviado", "Clicou", "Respondeu", "Incerto", "Falhou"]) {
      expect(within(tabela).getAllByText(estado).length, estado).toBeGreaterThan(0);
    }
    expect(within(tabela).getByText("missing_variable")).toBeInTheDocument();
  });

  it("filtro rápido, busca e seletores viram parâmetros da consulta; a busca espera parar de digitar", async () => {
    const s = servidor({ [OVERVIEW]: { corpo: { data: visao() } }, [FILA]: pagina([linhaDaFila("a", { name: "Ana" })]) });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await screen.findByText("Ana");
    const u = userEvent.setup();

    await u.click(screen.getByRole("button", { name: "Falhas" }));
    await waitFor(() => expect(s.feitas("GET", `${BASE}/contacts`).at(-1)!.consulta.get("status")).toBe("failed"));

    await u.type(screen.getByLabelText("Buscar contato"), "ana");
    const antes = s.feitas("GET", `${BASE}/contacts`).length;
    await waitFor(() => expect(s.feitas("GET", `${BASE}/contacts`).at(-1)!.consulta.get("q")).toBe("ana"));
    // Digitou 3 letras: uma consulta só, não três.
    expect(s.feitas("GET", `${BASE}/contacts`).length - antes).toBeLessThanOrEqual(1);

    await u.selectOptions(screen.getByLabelText("Versão da mensagem"), "v1");
    await waitFor(() => expect(s.feitas("GET", `${BASE}/contacts`).at(-1)!.consulta.get("version")).toBe("v1"));
    await u.selectOptions(screen.getByLabelText("Grupo de destino"), "d3");
    await waitFor(() => expect(s.feitas("GET", `${BASE}/contacts`).at(-1)!.consulta.get("destination")).toBe("d3"));
  });

  it("os botões dos alertas (?status=uncertain) já abrem a Fila filtrada", async () => {
    nav.status = "uncertain";
    const s = servidor({ [OVERVIEW]: { corpo: { data: visao() } }, [FILA]: pagina([]) });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await screen.findByText("Ninguém corresponde a este filtro");
    expect(screen.getByRole("button", { name: "Incertos" })).toHaveAttribute("aria-pressed", "true");
    expect(s.feitas("GET", `${BASE}/contacts`)[0]!.consulta.get("status")).toBe("uncertain");
  });

  it("paginação por cursor: 'Carregar mais' pede a página seguinte a partir do último", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [FILA]: (c) => (c.consulta.get("after") === "50" ? pagina([linhaDaFila("z", { name: "Zeca" })]) : pagina([linhaDaFila("a", { name: "Ana" })], "50")),
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await screen.findByText("Ana");
    await userEvent.setup().click(screen.getByRole("button", { name: "Carregar mais" }));
    await screen.findByText("Zeca");
    expect(s.feitas("GET", `${BASE}/contacts`).some((c) => c.consulta.get("after") === "50")).toBe(true);
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
  });

  it("clicar num contato abre a ficha: a mensagem exata, os dados do CSV e a linha do tempo com versão, número e grupo do momento", async () => {
    servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [FILA]: pagina([linhaDaFila("a", { name: "Maria Silva" })]),
      [`GET ${BASE}/contacts/a`]: { corpo: { data: perfil("a") } },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await userEvent.setup().click(await screen.findByText("Maria Silva"));
    const ficha = await screen.findByRole("dialog");
    await within(ficha).findByText("Mensagem enviada");
    expect(within(ficha).getByText(/Oi Maria! Entre no grupo/)).toBeInTheDocument();
    expect(within(ficha).getByText("Campinas")).toBeInTheDocument();
    expect(within(ficha).getByText("Importado na campanha")).toBeInTheDocument();
    expect(within(ficha).getByText("Mensagem V2 enviada por Número 01")).toBeInTheDocument();
    expect(within(ficha).getByText("Link clicado")).toBeInTheDocument();
    expect(within(ficha).getByRole("link", { name: "Abrir a conversa no Inbox" })).toHaveAttribute("href", "/app/inbox?id=conv-1");
  });

  it("envio INCERTO: quem pode decide (confirmando antes); quem não pode não vê os botões", async () => {
    const incerto = perfil("d", { state: "INCERTO", status: "uncertain", sent_at: null, clicked_at: null });
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [FILA]: pagina([linhaDaFila("d", { name: "Duda", status: "uncertain" })]),
      [`GET ${BASE}/contacts/d`]: { corpo: { data: incerto } },
      [`POST ${BASE}/contacts/d/resolve`]: { corpo: { data: { result: "ok" } } },
    });
    const { unmount } = renderizar(<CampanhaClient id={C1} pode={{ ...PODE_GERENTE, resolverIncerto: false }} />);
    await userEvent.setup().click(await screen.findByText("Duda"));
    await screen.findByText("Mensagem enviada", {}, { timeout: 200 }).catch(() => undefined);
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Foi enviada" })).toBeNull();
    unmount();
    cleanup();

    renderizar(<CampanhaClient id={C1} pode={PODE_GERENTE} />);
    const u = userEvent.setup();
    await u.click(await screen.findByText("Duda"));
    await u.click(await screen.findByRole("button", { name: "Foi enviada" }));
    const confirmar = await screen.findByRole("alertdialog");
    expect(within(confirmar).getByText(/conferiu no WhatsApp do número/)).toBeInTheDocument();
    expect(s.feitas("POST", `${BASE}/contacts/d/resolve`)).toHaveLength(0);
    await u.click(within(confirmar).getByRole("button", { name: "Foi enviada" }));
    await waitFor(() => expect(s.feitas("POST", `${BASE}/contacts/d/resolve`)[0]?.corpo).toEqual({ resolution: "sent" }));
  });
});

describe("Mensagens", () => {
  beforeEach(() => {
    nav.aba = "mensagens";
  });

  it("lista as versões (V2 ativa, V1 anterior) com quem criou e as métricas de cada uma", async () => {
    servidor({ [OVERVIEW]: { corpo: { data: visao() } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const v2 = (await screen.findByRole("heading", { name: "V2" })).closest("section")!;
    expect(within(v2).getByText("ativa")).toBeInTheDocument();
    expect(within(v2).getByText(/por Bruno/)).toBeInTheDocument();
    expect(within(v2).getByText(/3\.420 enviados · 1\.184 cliques/)).toBeInTheDocument();
    const v1 = screen.getByRole("heading", { name: "V1" }).closest("section")!;
    expect(within(v1).getByText("anterior")).toBeInTheDocument();
  });

  it("editar com a campanha rodando pergunta 'Aplicar esta nova versão aos próximos contatos da fila?' — aplicar ou só guardar", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [`POST ${BASE}/versions`]: { corpo: { data: { version_id: "v3", version_no: 3, activated: true, previous_version_no: 2 } } },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Editar mensagem/ }));
    const dialogo = await screen.findByRole("dialog");
    const campo = within(dialogo).getByLabelText("Texto da mensagem");
    await u.clear(campo);
    await u.type(campo, "Oi {{{{primeiro_nome}}! Última chance: {{{{link_grupo}}");
    // A prévia usa nome de exemplo e o link do destino — não um {{...}} cru.
    expect(within(dialogo).getByText(/Oi Maria! Última chance:/)).toBeInTheDocument();
    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    const pergunta = await screen.findByRole("alertdialog");
    expect(within(pergunta).getByText("Aplicar esta nova versão aos próximos contatos da fila?")).toBeInTheDocument();
    expect(within(pergunta).getByText(/Quem já recebeu continua com a versão anterior/)).toBeInTheDocument();
    expect(s.feitas("POST", `${BASE}/versions`)).toHaveLength(0);

    await u.click(within(pergunta).getByRole("button", { name: "Aplicar aos próximos" }));
    await waitFor(() => expect(s.feitas("POST", `${BASE}/versions`)).toHaveLength(1));
    expect(s.feitas("POST", `${BASE}/versions`)[0]!.corpo).toEqual({ body: "Oi {{primeiro_nome}}! Última chance: {{link_grupo}}", activate: true, based_on_version_no: 2 });
  });

  it("'Só guardar' cria a versão SEM aplicar", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [`POST ${BASE}/versions`]: { corpo: { data: { version_id: "v3", version_no: 3, activated: false, previous_version_no: 2 } } },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Editar mensagem/ }));
    const dialogo = await screen.findByRole("dialog");
    await u.type(within(dialogo).getByLabelText("Texto da mensagem"), " Vale hoje.");
    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));
    await u.click(await screen.findByRole("button", { name: "Só guardar, sem aplicar" }));
    await waitFor(() => expect(s.feitas("POST", `${BASE}/versions`)[0]?.corpo).toMatchObject({ activate: false }));
  });

  it("outra pessoa alterou enquanto eu editava: mostra o aviso do servidor e recarrega a versão atual", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [`POST ${BASE}/versions`]: { status: 409, corpo: { error: { code: "version_conflict", message: "A mensagem foi alterada por outra pessoa enquanto você editava." } } },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Editar mensagem/ }));
    const dialogo = await screen.findByRole("dialog");
    await u.type(within(dialogo).getByLabelText("Texto da mensagem"), " x");
    await u.click(within(dialogo).getByRole("button", { name: "Salvar" }));
    await u.click(await screen.findByRole("button", { name: "Aplicar aos próximos" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A mensagem foi alterada por outra pessoa enquanto você editava."));
    await waitFor(() => expect(s.feitas("GET", `${BASE}/overview`).length).toBeGreaterThan(1));
  });

  it("variável mal formada e texto vazio impedem salvar", async () => {
    servidor({ [OVERVIEW]: { corpo: { data: visao() } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Editar mensagem/ }));
    const dialogo = await screen.findByRole("dialog");
    const campo = within(dialogo).getByLabelText("Texto da mensagem");
    await u.clear(campo);
    expect(within(dialogo).getByRole("button", { name: "Salvar" })).toBeDisabled();
    await u.type(campo, "Oi {{{{nome");
    expect(within(dialogo).getByText(/variável mal formada/)).toBeInTheDocument();
    expect(within(dialogo).getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("?editar=1 (o botão do painel) já abre a edição; sem permissão de editar, não há botão", async () => {
    nav.editar = "1";
    servidor({ [OVERVIEW]: { corpo: { data: visao() } } });
    const { unmount } = renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    unmount();
    cleanup();
    renderizar(<CampanhaClient id={C1} pode={{ ...PODE_TUDO, editar: false }} />);
    await screen.findByRole("heading", { name: "V2" });
    expect(screen.queryByRole("button", { name: /Editar mensagem/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Destinos", () => {
  beforeEach(() => {
    nav.aba = "destinos";
  });

  it("mostra cada grupo com estado, capacidade e o que cada um recebeu; grupo sem ID no CRM é 'estimativa', não medida", async () => {
    servidor({ [OVERVIEW]: { corpo: { data: visao() } } });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const g4 = (await screen.findByRole("heading", { name: "BLACK #04" })).closest("article")!;
    expect(within(g4).getByText("ativo")).toBeInTheDocument();
    expect(within(g4).getByText(/920 de 1\.000 \(92%\)/)).toBeInTheDocument();
    expect(within(g4).getByText(/estimativa: o CRM não vê este grupo/)).toBeInTheDocument();
    expect(within(g4).getAllByText("não medido")).toHaveLength(2);
    const g3 = screen.getByRole("heading", { name: "BLACK #03" }).closest("article")!;
    expect(within(g3).getByText(/encerrado em .* \(lotado\)/)).toBeInTheDocument();
  });

  it("trocar de grupo confirma De → Para, pede o motivo e manda o grupo atual esperado (para não pisar em quem trocou antes)", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [`POST ${BASE}/destinations/d5/activate`]: { corpo: { data: { changed: true } } },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Trocar para este grupo" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByText("Trocar BLACK #04 → BLACK #05?")).toBeInTheDocument();
    expect(within(dialogo).getByText(/Quem já recebeu a mensagem continua com o link que recebeu/)).toBeInTheDocument();
    await u.selectOptions(within(dialogo).getByLabelText("Motivo"), "manual");
    await u.click(within(dialogo).getByRole("button", { name: "Confirmar troca" }));
    await waitFor(() => expect(s.feitas("POST", `${BASE}/destinations/d5/activate`)[0]?.corpo).toEqual({ expected_current: "d4", close_reason: "manual" }));
  });

  it("adicionar grupo valida o link do WhatsApp e o ID do grupo antes de enviar", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [`POST ${BASE}/destinations`]: { status: 201, corpo: { data: { destination_id: "d6", sequence_no: 6, activated: false } } },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: /Adicionar grupo/ }));
    const dialogo = await screen.findByRole("dialog");
    const enviar = within(dialogo).getByRole("button", { name: "Adicionar" });
    await u.type(within(dialogo).getByLabelText("Nome do grupo"), "BLACK #06");
    await u.type(within(dialogo).getByLabelText("Link de convite"), "https://evil.example.com/x");
    expect(within(dialogo).getByText(/Use o link de convite do WhatsApp/)).toBeInTheDocument();
    expect(enviar).toBeDisabled();
    await u.clear(within(dialogo).getByLabelText("Link de convite"));
    await u.type(within(dialogo).getByLabelText("Link de convite"), "https://chat.whatsapp.com/DDD444");
    await u.type(within(dialogo).getByLabelText("ID do grupo (opcional)"), "abc");
    expect(enviar).toBeDisabled();
    await u.clear(within(dialogo).getByLabelText("ID do grupo (opcional)"));
    await u.type(within(dialogo).getByLabelText("Capacidade (opcional)"), "1024");
    expect(enviar).toBeEnabled();
    await u.click(enviar);
    await waitFor(() => expect(s.feitas("POST", `${BASE}/destinations`)).toHaveLength(1));
    expect(s.feitas("POST", `${BASE}/destinations`)[0]!.corpo).toMatchObject({ name: "BLACK #06", invite_url: "https://chat.whatsapp.com/DDD444", capacity: 1024, group_chat_id: null, activate: false });
  });
});

describe("Atividade", () => {
  beforeEach(() => {
    nav.aba = "atividade";
  });

  it("conta a história em frases, com quem fez; por padrão só a campanha, e os envios individuais são opcionais", async () => {
    const s = servidor({
      [OVERVIEW]: { corpo: { data: visao() } },
      [`GET ${BASE}/events`]: {
        corpo: {
          data: [
            { id: "e3", kind: "destination_changed", occurred_at: "2026-09-21T14:00:00Z", actor_user_id: "u1", actor_name: "Bruno", message_version_id: null, destination_id: "d4", channel_session_id: null, campaign_contact_id: null, payload: { from_name: "BLACK #03", to_name: "BLACK #04" } },
            { id: "e2", kind: "version_activated", occurred_at: "2026-09-21T13:00:00Z", actor_user_id: "u1", actor_name: "Bruno", message_version_id: "v2", destination_id: null, channel_session_id: null, campaign_contact_id: null, payload: { from_version_no: 1, to_version_no: 2 } },
            { id: "e1", kind: "started", occurred_at: "2026-09-21T12:00:00Z", actor_user_id: "u1", actor_name: "Bruno", message_version_id: null, destination_id: null, channel_session_id: null, campaign_contact_id: null, payload: {} },
          ],
          meta: { cursor: null, has_more: false },
        },
      },
    });
    renderizar(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    expect(await screen.findByText("Bruno alterou o destino BLACK #03 → BLACK #04")).toBeInTheDocument();
    expect(screen.getByText("Bruno alterou a mensagem V1 → V2")).toBeInTheDocument();
    expect(screen.getByText("Bruno iniciou a campanha")).toBeInTheDocument();
    expect(s.feitas("GET", `${BASE}/events`)[0]!.consulta.get("scope")).toBe("campaign");

    await userEvent.setup().click(screen.getByLabelText(/Incluir cada envio, clique e resposta/));
    await waitFor(() => expect(s.feitas("GET", `${BASE}/events`).at(-1)!.consulta.get("scope")).toBe("all"));
  });
});
