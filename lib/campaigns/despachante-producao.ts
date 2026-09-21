/**
 * A ligação do despachante ao mundo real: banco (service role), o caminho de envio do
 * CRM, o ledger de ritmo e a auditoria. É só fiação — a regra está em `despachante.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { audit } from "@/lib/audit";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { logger } from "@/lib/logger";

import type { DepsDoDespachante } from "./despachante";
import { enviarTextoPelaCentral } from "./envio";
import { carregarRitmoDoCanal, enviadosHojePelaCampanha, registrarEnvioNoLedger } from "./ritmo";

export function depsDeProducao(admin: SupabaseClient, opcoes: { baseDoRastreio?: string | null } = {}): DepsDoDespachante {
  return {
    async chamar<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw new Error(`${fn}: ${error.message}`);
      return data as T;
    },
    agora: () => new Date(),
    ritmoDoCanal: (alvo, agora) =>
      carregarRitmoDoCanal(admin, alvo.organization_id, alvo.channel_session_id, agora, {
        provider: alvo.channel_provider,
        dailyMessageLimit: alvo.daily_message_limit,
      }),
    enviadosHojePelaCampanha: (alvo, ritmo, agora) =>
      enviadosHojePelaCampanha(admin, alvo.campaign_id, alvo.channel_session_id, dayStartInTz(agora, ritmo.knobs.timezone)),
    async nomeDoContato(orgId, contactId) {
      const { data } = await admin
        .from("contacts")
        .select("display_name, name, phone_number")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      return nomeDoContato((data as { display_name: string | null; name: string | null; phone_number: string | null } | null) ?? null);
    },
    enviarTexto: enviarTextoPelaCentral(admin),
    registrarEnvio: (orgId, channelId, quando) => registrarEnvioNoLedger(admin, orgId, channelId, quando),
    baseDoRastreio: opcoes.baseDoRastreio ?? null,
    auditarPausa(orgId, campaignId, motivo) {
      void audit({
        action: "campaign.paused",
        organizationId: orgId,
        resourceType: "campaign",
        resourceId: campaignId,
        metadata: { reason: motivo, automatic: true },
      });
    },
    log(nivel, msg, ctx) {
      logger[nivel](msg, ctx);
    },
  };
}
