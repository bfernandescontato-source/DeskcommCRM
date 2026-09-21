/**
 * QUEM PODE O QUÊ na Central de Disparos — a matriz numa tabela só.
 *
 * As rotas pedem o papel mínimo daqui a `requireRole()`; nenhuma rota compara
 * papel na mão (anti-pattern "matriz advisória" do CLAUDE.md). A regra:
 *
 *   ler                              viewer   — ver campanhas e números
 *   operar o dia a dia               manager  — criar, importar, editar a mensagem,
 *                                               trocar o destino, pausar, retomar
 *   o que não desfaz ou fala pelo    admin    — INICIAR (o primeiro envio é irreversível),
 *   negócio inteiro                             ENCERRAR e CANCELAR
 *
 * Iniciar fica no admin porque enviar mensagem a uma pessoa é irreversível e nunca
 * é operação comum (doutrina do Sistema Vivo). Pausar e retomar ficam no manager
 * porque quem opera a campanha precisa poder frear sem chamar o dono.
 */
import type { Role } from "@/lib/auth/types";

import type { AcaoDaApi } from "./schemas";

export type AcaoDeCampanha =
  | "ler"
  | "criar"
  | "configurar"
  | "importar"
  | "editar_mensagem"
  | "trocar_destino"
  | "trocar_canais"
  | AcaoDaApi;

export const PAPEL_MINIMO: Record<AcaoDeCampanha, Role> = {
  ler: "viewer",
  criar: "manager",
  configurar: "manager",
  importar: "manager",
  editar_mensagem: "manager",
  trocar_destino: "manager",
  trocar_canais: "manager",
  ready: "manager",
  pause: "manager",
  resume: "manager",
  start: "admin",
  complete: "admin",
  cancel: "admin",
};

export function papelMinimo(acao: AcaoDeCampanha): Role {
  return PAPEL_MINIMO[acao];
}
