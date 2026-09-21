import { describe, expect, it } from "vitest";

import { baseDoRastreioDaInstalacao } from "@/lib/campaigns/despachante-producao";
import { classificarAgente, destinoSeguro, type AlvoDoClique } from "@/lib/campaigns/rastreio";
import { CAMPAIGN_CLICK_AGENT_CLASSES } from "@/lib/campaigns/vocabulario";
import { isPublicPath } from "@/lib/auth/public-paths";

describe("classificarAgente — só navegador de pessoa é clique", () => {
  it("navegador comum (celular e computador) é pessoa", () => {
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0",
    ]) {
      expect(classificarAgente(ua, "GET"), ua).toBe("browser");
    }
  });

  it("a pré-visualização do WhatsApp e de outros serviços NÃO é clique", () => {
    for (const ua of ["WhatsApp/2.24.10.85 A", "WhatsApp/2.2412.54 i", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "TelegramBot (like TwitterBot)", "Slackbot-LinkExpanding 1.0", "Twitterbot/1.0"]) {
      expect(classificarAgente(ua, "GET"), ua).toBe("preview");
    }
  });

  it("robôs, ferramentas de linha de comando e navegador sem cabeça não são pessoas", () => {
    for (const ua of ["curl/8.4.0", "python-requests/2.31.0", "Mozilla/5.0 (compatible; bingbot/2.0)", "Go-http-client/2.0", "HeadlessChrome/126", "okhttp/4.12.0"]) {
      expect(classificarAgente(ua, "GET"), ua).toBe("bot");
    }
  });

  it("sem user-agent é robô; HEAD nunca é clique de pessoa", () => {
    expect(classificarAgente(null, "GET")).toBe("bot");
    expect(classificarAgente("   ", "GET")).toBe("bot");
    expect(classificarAgente("Mozilla/5.0 Chrome/126", "HEAD")).toBe("bot");
  });

  it("toda classe devolvida existe no vocabulário do banco", () => {
    for (const c of [classificarAgente("Mozilla/5.0 Chrome", "GET"), classificarAgente("WhatsApp/2", "GET"), classificarAgente(null, "GET")]) {
      expect(CAMPAIGN_CLICK_AGENT_CLASSES).toContain(c);
    }
  });
});

describe("destinoSeguro — a última barreira antes de redirecionar", () => {
  const alvo = (url: string): AlvoDoClique => ({
    campaign_contact_id: "cc", campaign_id: "c", organization_id: "o", message_version_id: null, destination_id: "d", from_destination_id: null, url,
  });
  it("só convite de WhatsApp em https", () => {
    expect(destinoSeguro(alvo("https://chat.whatsapp.com/AbCdEf123456"))).toBe(true);
    expect(destinoSeguro(null)).toBe(false);
    for (const ruim of ["http://chat.whatsapp.com/AbCdEf123456", "https://evil.example/x", "javascript:alert(1)", "https://user@chat.whatsapp.com/AbCd", "//evil.example", "/api/v1/contacts", ""]) {
      expect(destinoSeguro(alvo(ruim)), ruim).toBe(false);
    }
  });
});

describe("base do link rastreável", () => {
  it("só https; localhost e vazio mandam o convite cru (nunca link quebrado a milhares de pessoas)", () => {
    expect(baseDoRastreioDaInstalacao("https://crm.elevapay.pro")).toBe("https://crm.elevapay.pro");
    expect(baseDoRastreioDaInstalacao("https://crm.elevapay.pro///")).toBe("https://crm.elevapay.pro");
    expect(baseDoRastreioDaInstalacao("http://localhost:3000")).toBeNull();
    expect(baseDoRastreioDaInstalacao("http://crm.exemplo.test")).toBeNull();
    expect(baseDoRastreioDaInstalacao("")).toBeNull();
    expect(baseDoRastreioDaInstalacao(undefined)).toBeNull();
  });
});

describe("/g/<token> é público — e só no formato exato do token", () => {
  it("libera o token de 20 hex minúsculos e nada além dele", () => {
    expect(isPublicPath("/g/9f3a1c0b7d2e4a5b6c7d")).toBe(true);
    for (const ruim of ["/g/", "/g", "/g/abc", "/g/9f3a1c0b7d2e4a5b6c7d/extra", "/g/9F3A1C0B7D2E4A5B6C7D", "/g/9f3a1c0b7d2e4a5b6c7dX", "/g/../api/v1/contacts", "/gx/9f3a1c0b7d2e4a5b6c7d"]) {
      expect(isPublicPath(ruim), ruim).toBe(false);
    }
  });
});
