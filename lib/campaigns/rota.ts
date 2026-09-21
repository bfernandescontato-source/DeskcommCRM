/**
 * O esqueleto comum das rotas `/api/v1/campaigns/**`.
 *
 * Toda rota da Central de Disparos faz as mesmas cinco coisas, na mesma ordem, e
 * esta função as faz uma vez só — para que rota nova não possa esquecer nenhuma:
 *
 *   1. escrita passa o guarda do modo suporte somente-leitura (`apoio: await requireSupportWrite()`);
 *   2. `requireRole(papel da ação)` — papel e organização de fonte confiável;
 *   3. o corpo passa pelo Zod (`.strict()`);
 *   4. erro de campanha (`CampanhaError`) vira resposta com código estável;
 *   5. erro inesperado vira 500 SEM vazar mensagem interna.
 *
 * A organização vem SEMPRE de `c.org.orgId` e nunca do corpo ou da URL.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { z } from "zod";

import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";

import { papelMinimo, type AcaoDeCampanha } from "./permissoes";
import { CampanhaError, dbDeCampanhas, type Db } from "./service";

export interface ContextoDaRota {
  requestId: string;
  user: AuthUser;
  org: ActiveOrg;
  db: Db;
  /** Traduz a frase para o idioma de quem chamou (pt-BR devolve o próprio texto). */
  t: (texto: string) => string;
  /** Registra na auditoria (fire-and-forget) — só chame quando houve efeito. */
  audita: (action: AuditAction, campaignId: string, metadata?: Record<string, unknown>) => void;
  /** Exige um papel MAIOR que o da rota (ex.: iniciar exige admin; pausar, manager). */
  exigir: (acao: AcaoDeCampanha) => Promise<Response | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ehUuid = (v: string): boolean => UUID.test(v);

export async function rotaDeCampanha(
  /**
   * `apoio` é o resultado de `requireSupportWrite()` — a rota de ESCRITA o chama na
   * própria linha, e não aqui dentro, porque o gate `suporte-cobertura-de-efeitos`
   * confere por texto que todo handler de escrita o invoca. Não nulo = o modo suporte
   * somente-leitura barrou: devolve essa resposta sem tocar em nada.
   */
  opcoes: { acao: AcaoDeCampanha; apoio?: Response | null },
  executar: (c: ContextoDaRota) => Promise<Response>,
): Promise<Response> {
  if (opcoes.apoio) return opcoes.apoio;
  const requestId = randomUUID();
  const authz = await requireRole(papelMinimo(opcoes.acao), { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  const contexto: ContextoDaRota = {
    requestId,
    user,
    org,
    db: dbDeCampanhas(),
    t,
    audita: (action, campaignId, metadata) => {
      void audit({
        action,
        actorUserId: user.id,
        organizationId: org.orgId,
        resourceType: "campaign",
        resourceId: campaignId,
        requestId,
        metadata,
      });
    },
    exigir: async (acao) => {
      const r = await requireRole(papelMinimo(acao), { requestId, resource: "campaigns" });
      return r.ok ? null : r.response;
    },
  };

  try {
    return await executar(contexto);
  } catch (e) {
    if (e instanceof CampanhaError) {
      return fail(e.erro.code, t(e.erro.message), e.erro.status, { requestId, details: e.erro.details });
    }
    logger.error("[disparos] erro inesperado na rota", {
      requestId,
      erro: e instanceof Error ? e.message : "unknown",
    });
    return fail("internal_error", t("Erro ao processar a campanha."), 500, { requestId });
  }
}

/** Lê o corpo JSON e valida. Devolve a resposta 422 pronta quando não passa. */
export async function lerCorpo<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
  c: Pick<ContextoDaRota, "requestId" | "t">,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  const bruto = await req.json().catch(() => null);
  const parsed = schema.safeParse(bruto);
  if (!parsed.success) {
    return {
      ok: false,
      response: fail("validation_failed", c.t("Dados inválidos."), 422, {
        requestId: c.requestId,
        details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** Recusa o id que não é UUID antes de tocar no banco. */
export function idInvalido(c: Pick<ContextoDaRota, "requestId" | "t">, ...ids: string[]): Response | null {
  return ids.every(ehUuid) ? null : fail("not_found", c.t("Não encontrado."), 404, { requestId: c.requestId });
}
