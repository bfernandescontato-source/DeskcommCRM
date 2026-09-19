import { describe, expect, it } from "vitest";

import { corDoParticipante, participanteDoGrupo } from "@/lib/inbox/participante-do-grupo";

describe("participanteDoGrupo", () => {
  const meta = (m: Record<string, unknown>) => ({ direction: "inbound", metadata: { is_group: true, ...m } });

  it("nome quando existe; senão telefone; senão rótulo genérico", () => {
    expect(participanteDoGrupo(meta({ group_participant_name: "Ana", group_participant_phone: "+5511992299000" }))?.nome).toBe("Ana");
    expect(participanteDoGrupo(meta({ group_participant_phone: "+5511992299000" }))?.nome).toBe("+5511992299000");
    expect(participanteDoGrupo(meta({}))?.nome).toBe("Participante");
  });

  it("nunca devolve o id técnico como nome", () => {
    expect(participanteDoGrupo(meta({ group_participant: "273310747197632@lid" }))?.nome).toBe("Participante");
  });

  it("nome só com espaços não conta como nome", () => {
    expect(participanteDoGrupo(meta({ group_participant_name: "   ", group_participant_phone: "+5511992299000" }))?.nome).toBe("+5511992299000");
  });

  it("null fora de grupo e para o que saiu de nós", () => {
    expect(participanteDoGrupo({ direction: "inbound", metadata: { group_participant_name: "Ana" } })).toBeNull();
    expect(participanteDoGrupo({ direction: "outbound", metadata: { is_group: true, group_participant_name: "Ana" } })).toBeNull();
    expect(participanteDoGrupo({ direction: "inbound", metadata: null })).toBeNull();
  });

  it("a chave é o id da pessoa — não o nome, que ela pode trocar", () => {
    expect(participanteDoGrupo(meta({ group_participant: "1@lid", group_participant_name: "Ana" }))?.chave).toBe("1@lid");
    expect(participanteDoGrupo(meta({ group_participant_phone: "+5511992299000" }))?.chave).toBe("+5511992299000");
  });
});

describe("corDoParticipante", () => {
  it("a mesma pessoa tem sempre a mesma cor", () => {
    expect(corDoParticipante("273310747197632@lid")).toBe(corDoParticipante("273310747197632@lid"));
  });

  it("pessoas diferentes se espalham pela paleta (não caem todas numa cor só)", () => {
    const cores = new Set(Array.from({ length: 40 }, (_, i) => corDoParticipante(`${i}00000@lid`)));
    expect(cores.size).toBeGreaterThan(3);
  });

  it("sempre devolve uma classe de cor com variante escura", () => {
    expect(corDoParticipante("x")).toMatch(/^text-\w+-700 dark:text-\w+-400$/);
  });
});
