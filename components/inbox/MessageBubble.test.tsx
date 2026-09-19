/**
 * O balão diz de quem saiu a mensagem.
 *
 * `external_device` é a resposta dada pelo WhatsApp do CELULAR (fora do CRM) —
 * antes ela chegava à bolha sem rótulo, indistinguível do que foi digitado no
 * CRM. Este teste prende cada valor de `sent_via` ao rótulo certo, mais o caso
 * que NÃO leva rótulo (mensagem recebida).
 *
 * `sent_via='user'` não diz QUAL humano digitou — só que um humano digitou. Por
 * isso "Você" depende de duas pontas: `viewerUserId` (quem lê) e
 * `sent_by_user_id` (quem enviou). Faltando qualquer uma, o rótulo é
 * "Atendente"; os casos abaixo prendem as três combinações (sou eu, é o colega,
 * não se sabe).
 *
 * Não há caso para `'automation'`: nenhum emissor grava esse valor, e o
 * componente deixou de nomeá-lo. Quem guarda essa propriedade — nas duas
 * direções — é tests/unit/rotulo-de-origem-tem-emissor.test.ts.
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR), então o texto
 * esperado é o português — o espanhol é coberto por i18n-espanhol-cobre-a-tela.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "outbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "corpo da mensagem",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-09-08T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-08T12:00:00.000Z",
    ...over,
  };
}

describe("MessageBubble — rótulo de origem", () => {
  it("resposta pelo celular (external_device) mostra 'Celular'", () => {
    render(<MessageBubble message={msg({ sent_via: "external_device" })} />);
    expect(screen.getByText("Celular")).toBeInTheDocument();
  });

  it("automação não inventa rótulo — ninguém grava esse valor", () => {
    render(<MessageBubble message={msg({ sent_via: "automation" })} />);
    expect(screen.queryByText("Automação")).not.toBeInTheDocument();
  });

  it("digitada no CRM por QUEM ESTÁ LENDO mostra 'Você'", () => {
    render(
      <MessageBubble
        message={msg({ sent_via: "user", sent_by_user_id: "u-eu" })}
        viewerUserId="u-eu"
      />,
    );
    expect(screen.getByText("Você")).toBeInTheDocument();
  });

  it("digitada no CRM pelo COLEGA mostra 'Atendente', nunca 'Você'", () => {
    render(
      <MessageBubble
        message={msg({ sent_via: "user", sent_by_user_id: "u-colega" })}
        viewerUserId="u-eu"
      />,
    );
    expect(screen.getByText("Atendente")).toBeInTheDocument();
    expect(screen.queryByText("Você")).not.toBeInTheDocument();
  });

  it("sem emissor gravado (sent_by_user_id nulo) mostra 'Atendente'", () => {
    // Os dois nulos se equivalem em `===`. Sem a guarda de `viewerUserId != null`
    // este caso voltaria a dizer "Você" para uma mensagem de dono desconhecido.
    render(<MessageBubble message={msg({ sent_via: "user", sent_by_user_id: null })} />);
    expect(screen.getByText("Atendente")).toBeInTheDocument();
    expect(screen.queryByText("Você")).not.toBeInTheDocument();
  });

  it("crm (o DEFAULT da coluna) segue a mesma regra de 'user'", () => {
    render(
      <MessageBubble
        message={msg({ sent_via: "crm", sent_by_user_id: "u-eu" })}
        viewerUserId="u-eu"
      />,
    );
    expect(screen.getByText("Você")).toBeInTheDocument();
  });

  it("IA continua mostrando 'IA' (comportamento preservado)", () => {
    render(<MessageBubble message={msg({ sent_via: "ai" })} />);
    expect(screen.getByText("IA")).toBeInTheDocument();
  });

  it("mensagem recebida (inbound) não leva rótulo de origem", () => {
    render(
      <MessageBubble message={msg({ sent_via: "external_device", direction: "inbound" })} />,
    );
    expect(screen.queryByText("Celular")).not.toBeInTheDocument();
  });

  it("system não inventa rótulo", () => {
    render(<MessageBubble message={msg({ sent_via: "system" })} />);
    for (const rotulo of ["Celular", "Automação", "Você", "Atendente", "IA"]) {
      expect(screen.queryByText(rotulo)).not.toBeInTheDocument();
    }
  });
});

/**
 * EM GRUPO, O BALÃO DIZ QUEM FALOU.
 *
 * A conversa do grupo é uma só; o que separa as pessoas é
 * `metadata.group_participant_*`, gravado na ingestão. Como no WhatsApp: o nome
 * quando existe, o telefone quando não, e nunca o id técnico (`123@lid`).
 */
describe("mensagem de grupo mostra quem falou", () => {
  const deGrupo = (metadata: Record<string, unknown>, over: Partial<Message> = {}) =>
    msg({ direction: "inbound", sent_via: "external_device", metadata: { is_group: true, ...metadata }, ...over });

  it("⭐ mostra o NOME de quem falou", () => {
    render(<MessageBubble message={deGrupo({ group_participant: "1@lid", group_participant_name: "Ana Souza" })} />);
    expect(screen.getByText("Ana Souza")).toBeTruthy();
  });

  it("sem nome, mostra o TELEFONE — como o WhatsApp faz com número não salvo", () => {
    render(<MessageBubble message={deGrupo({ group_participant: "1@lid", group_participant_phone: "+5511992299000" })} />);
    expect(screen.getByText("+5511992299000")).toBeTruthy();
  });

  it("nunca mostra o id técnico do remetente", () => {
    const { container } = render(<MessageBubble message={deGrupo({ group_participant: "273310747197632@lid" })} />);
    expect(container.textContent).not.toContain("273310747197632");
    expect(screen.getByText("Participante")).toBeTruthy();
  });

  it("CONTROLE: conversa comum (fora de grupo) não ganha nome de participante", () => {
    render(<MessageBubble message={msg({ direction: "inbound", sent_via: "external_device", metadata: { group_participant_name: "Ana Souza" } })} />);
    expect(screen.queryByText("Ana Souza")).toBeNull();
  });

  it("CONTROLE: o que NÓS mandamos no grupo não leva nome de participante", () => {
    render(<MessageBubble message={msg({ direction: "outbound", metadata: { is_group: true, group_participant_name: "Ana Souza" } })} />);
    expect(screen.queryByText("Ana Souza")).toBeNull();
  });

  it("⭐ a citação nomeia a PESSOA citada, e não 'Cliente'", () => {
    const citada = deGrupo({ group_participant: "1@lid", group_participant_name: "Bia Lima" }, { id: "m0", body: "qual o preço?" });
    render(<MessageBubble message={msg({ direction: "outbound", body: "R$ 10" })} citada={citada} />);
    expect(screen.getByText("Bia Lima")).toBeTruthy();
    expect(screen.queryByText("Cliente")).toBeNull();
  });
});
