import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Assistente } from "@/app/app/disparos/_components/Assistente";
import { CampanhaClient } from "@/app/app/disparos/_components/CampanhaClient";
import { PainelClient } from "@/app/app/disparos/_components/PainelClient";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

import { C1, PAINEL, PODE_TUDO, linhaDaFila, perfil, renderizar, servidor, visao } from "./apoio";

/**
 * NENHUM PORTUGUÊS VAZA NO ESPANHOL — provado renderizando cada tela em espanhol e procurando
 * marcas de português no texto que chegou ao olho. O que é DADO do fixture (nome da campanha, texto
 * da mensagem, frase que o servidor mandou) fica de fora: dado de usuário não se traduz.
 */
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/disparos/x",
  useSearchParams: () => nav.params,
}));

// Só o que é PORTUGUÊS e não é espanhol: ç/ã/õ/circunflexo, "lh/nh" antes de vogal e palavras que o espanhol escreve diferente.
const MARCA = /[çãõêôâà]|(lh|nh)[aeiou]|\b(não|você|também|então|aqui|desta|deste|nesta|neste|dele|dela|pelo|pela|mais|ainda|já|só|muito|sobre|depois|sempre|seu|sua|isso|essa|esse|quem|quando|agora|criada|substituída|clicaram|entraram|saíram)\b/i;
// Dado de fixture: nomes, o texto que a pessoa escreveu e a frase que o servidor mandou (já no idioma dele).
const DADO = [/BLACK/, /Campanha pausada/, /Meu rascunho/, /Oi \{\{|Oi Maria|Oi Ana|Oi \{/, /Entre no grupo|entre: /, /está com 92%/, /Maria Silva/, /lista(-black)?\.csv/, /Número 0\d/, /Campinas/, /Última chance/];

function vazamentos(): string[] {
  const achados = new Set<string>();
  const alvo = document.body;
  const walker = document.createTreeWalker(alvo, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t && MARCA.test(t) && !DADO.some((d) => d.test(t))) achados.add(t);
  }
  for (const el of alvo.querySelectorAll("[aria-label],[placeholder],[title]")) {
    for (const a of ["aria-label", "placeholder", "title"]) {
      const v = el.getAttribute(a);
      if (v && MARCA.test(v) && !DADO.some((d) => d.test(v))) achados.add(`[${a}] ${v}`);
    }
  }
  return [...achados];
}

const BASE = `/api/v1/campaigns/${C1}`;
const pagina = (linhas: unknown[]) => ({ corpo: { data: linhas, meta: { cursor: null, has_more: false } } });
const emEspanhol = (ui: React.ReactElement) => renderizar(<IdiomaProvider locale="es">{ui}</IdiomaProvider>);

beforeEach(() => {
  nav.params = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("nenhum português vaza no espanhol", () => {
  it("painel", async () => {
    servidor({ "GET /api/v1/campaigns/dashboard": { corpo: { data: PAINEL } } });
    emEspanhol(<PainelClient pode={PODE_TUDO} />);
    await screen.findByText("BLACK Friday");
    expect(vazamentos()).toEqual([]);
  });

  for (const aba of ["visao", "mensagens", "destinos", "atividade", "fila"]) {
    it(`campanha › aba ${aba}`, async () => {
      nav.params = new URLSearchParams({ aba });
      servidor({
        [`GET ${BASE}/overview`]: { corpo: { data: visao({ alerts: [{ level: "critical", code: "x", message: "Campanha pausada: nenhum número está conectado.", action: "edit_channels" }] }) } },
        [`GET ${BASE}/contacts`]: pagina([linhaDaFila("a", { name: "Maria Silva" }), linhaDaFila("b", { name: "Bia", status: "failed", last_error_code: "missing_variable" }), linhaDaFila("c", { name: "Caio", status: "skipped", skip_reason: "declined_marketing" })]),
        [`GET ${BASE}/events`]: {
          corpo: {
            data: [
              { id: "e1", kind: "destination_changed", occurred_at: "2026-09-21T14:00:00Z", actor_user_id: "u", actor_name: "Bruno", message_version_id: null, destination_id: "d4", channel_session_id: null, campaign_contact_id: null, payload: { from_name: "BLACK #03", to_name: "BLACK #04" } },
              { id: "e2", kind: "paused", occurred_at: "2026-09-21T13:00:00Z", actor_user_id: null, actor_name: null, message_version_id: null, destination_id: null, channel_session_id: null, campaign_contact_id: null, payload: { reason: "channel_down" } },
            ],
            meta: { cursor: null, has_more: false },
          },
        },
      });
      emEspanhol(<CampanhaClient id={C1} pode={PODE_TUDO} />);
      await screen.findByRole("heading", { name: "BLACK Friday" });
      if (aba === "fila") await screen.findByText("Maria Silva");
      if (aba === "atividade") await screen.findByText(/cambió el destino/);
      expect(vazamentos()).toEqual([]);
    });
  }

  it("campanha › ficha do contato (com envio incerto e linha do tempo)", async () => {
    nav.params = new URLSearchParams({ aba: "fila" });
    servidor({
      [`GET ${BASE}/overview`]: { corpo: { data: visao() } },
      [`GET ${BASE}/contacts`]: pagina([linhaDaFila("d", { name: "Duda", status: "uncertain" })]),
      [`GET ${BASE}/contacts/d`]: { corpo: { data: perfil("d", { state: "INCERTO", status: "uncertain" }) } },
    });
    emEspanhol(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await userEvent.setup().click(await screen.findByText("Duda"));
    await screen.findByText(/No se puede saber si este mensaje salió/);
    expect(vazamentos()).toEqual([]);
  });

  it("campanha › diálogos (editar mensagem, adicionar grupo, confirmar encerrar)", async () => {
    nav.params = new URLSearchParams({ aba: "mensagens", editar: "1" });
    servidor({ [`GET ${BASE}/overview`]: { corpo: { data: visao() } } });
    emEspanhol(<CampanhaClient id={C1} pode={PODE_TUDO} />);
    await screen.findByRole("dialog");
    expect(vazamentos()).toEqual([]);
  });

  for (const passo of ["contatos", "mensagem", "destino", "envio", "revisao"]) {
    it(`assistente › passo ${passo}`, async () => {
      nav.params = new URLSearchParams({ id: C1, passo });
      const v = visao();
      Object.assign(v.campaign, { status: "draft", active_version_id: null, active_destination_id: null });
      Object.assign(v, { versions: [], destinations: [], channels: [] });
      servidor({
        [`GET ${BASE}/overview`]: { corpo: { data: v } },
        "GET /api/v1/channel-sessions": { corpo: { data: [{ id: "s1", display_name: "Número 01", phone_number: "1", waha_session_name: "n1", status: "WORKING", daily_message_limit: 300 }], meta: {} } },
      });
      emEspanhol(<Assistente pode={PODE_TUDO} />);
      await waitFor(() => expect(screen.getByRole("navigation", { name: "Pasos" })).toBeInTheDocument());
      expect(vazamentos()).toEqual([]);
    });
  }
});
