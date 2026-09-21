import { describe, expect, it, vi } from "vitest";

import { extrairAvisosDeGrupo, registrarAvisoDeGrupo } from "./grupos";

const GRUPO = "120363000000000000@g.us";
const AGORA = new Date("2026-09-21T12:00:00Z");

describe("avisos de grupo da Central de Disparos", () => {
  it("lê entradas de vários participantes, preservando telefone e LID sem guardar o bruto", () => {
    const avisos = extrairAvisosDeGrupo("group.v2.participants", {
      group: { id: GRUPO },
      action: "add",
      timestamp: 1_790_000_000,
      participants: ["5511999998888@c.us", { id: "12345@lid" }],
    }, AGORA);

    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toMatchObject({ grupo: GRUPO, tipo: "join", participante: "tel:5511999998888" });
    expect(avisos[0]?.telefones).toContain("+5511999998888");
    expect(avisos[1]).toMatchObject({ participante: "lid:12345", lid: "12345", telefones: [] });
  });

  it("aceita timestamp em segundos e milissegundos, mas nunca um relógio do futuro", () => {
    const base = { groupId: GRUPO, type: "leave", participants: ["5511999998888@c.us"] };
    expect(extrairAvisosDeGrupo("group.v2.participants", { ...base, timestamp: 1_790_000_000 }, AGORA)[0]?.quando.toISOString()).toBe("2026-09-21T14:13:20.000Z");
    expect(extrairAvisosDeGrupo("group.v2.participants", { ...base, timestamp: 1_790_000_000_000 }, AGORA)[0]?.quando.toISOString()).toBe("2026-09-21T14:13:20.000Z");
    expect(extrairAvisosDeGrupo("group.v2.participants", { ...base, timestamp: AGORA.getTime() + 48 * 60 * 60 * 1000 }, AGORA)[0]?.quando).toEqual(AGORA);
  });

  it("ignora em silêncio evento, grupo, ação ou participante que não reconhece", () => {
    expect(extrairAvisosDeGrupo("group.v2.join", { groupId: GRUPO, type: "join", participants: ["5511@c.us"] }, AGORA)).toEqual([]);
    expect(extrairAvisosDeGrupo("group.v2.participants", { groupId: "5511999998888@c.us", type: "join", participants: ["5511@c.us"] }, AGORA)).toEqual([]);
    expect(extrairAvisosDeGrupo("group.v2.participants", { groupId: GRUPO, type: "promote", participants: ["5511@c.us"] }, AGORA)).toEqual([]);
  });

  it("entrega cada aviso ao banco e não deixa uma falha impedir os próximos", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { recorded: 1, attributed: 1 }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "db indisponível" } });
    const resultado = await registrarAvisoDeGrupo({ rpc }, { id: "session-1", organization_id: "org-1" }, "group.v2.participants", {
      groupId: GRUPO,
      type: "join",
      participants: ["5511999998888@c.us", "5511888887777@c.us"],
    }, AGORA);

    expect(resultado).toEqual({ avisos: 2, registrados: 1, atribuidos: 1, erros: 1 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_org: "org-1", p_session: "session-1", p_group_chat_id: GRUPO, p_kind: "join" });
  });
});
