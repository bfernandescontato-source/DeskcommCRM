/**
 * QUEM PODE O QUÊ na Central de Disparos — a matriz numa tabela só.
 *
 * As rotas pedem o papel mínimo daqui a `requireRole()`; nenhuma rota compara
 * papel na mão (anti-pattern "matriz advisória" do CLAUDE.md). A regra:
 *
 *   ler e operar o dia a dia         manager  — ver campanhas, números e a Fila; criar,
 *                                               importar, editar a mensagem, trocar o
 *                                               destino, pausar, retomar
 *   o que não desfaz ou fala pelo    admin    — INICIAR (o primeiro envio é irreversível),
 *   negócio inteiro                             ENCERRAR e CANCELAR
 *
 * Iniciar fica no admin porque enviar mensagem a uma pessoa é irreversível e nunca
 * é operação comum (doutrina do Sistema Vivo). Pausar e retomar ficam no manager
 * porque quem opera a campanha precisa poder frear sem chamar o dono.
 */
import { roleAtLeast, type Role } from "@/lib/auth/types";

import type { AcaoDaApi } from "./schemas";

export type AcaoDeCampanha =
  | "ler"
  | "criar"
  | "configurar"
  | "importar"
  | "editar_mensagem"
  | "trocar_destino"
  | "trocar_canais"
  | "resolver_incerto"
  | AcaoDaApi;

export const PAPEL_MINIMO: Record<AcaoDeCampanha, Role> = {
  // A Fila lista o telefone de até dezenas de milhares de pessoas: ler é da gerência, como operar.
  ler: "manager",
  criar: "manager",
  configurar: "manager",
  importar: "manager",
  editar_mensagem: "manager",
  trocar_destino: "manager",
  trocar_canais: "manager",
  resolver_incerto: "manager",
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

/**
 * O que a TELA mostra para cada papel. É só o botão que a ROTA aceitaria — a segurança real é
 * `requireRole()` na rota; esconder o botão evita oferecer o que voltaria como "sem permissão".
 */
export interface PermissoesDaCentral {
  ver: boolean;
  criar: boolean;
  editar: boolean;
  pausar: boolean;
  iniciar: boolean;
  encerrar: boolean;
  resolverIncerto: boolean;
}

export function permissoesDaCentral(papel: string | null | undefined): PermissoesDaCentral {
  const pode = (a: AcaoDeCampanha) => roleAtLeast(papel, PAPEL_MINIMO[a]);
  return {
    ver: pode("ler"),
    criar: pode("criar"),
    editar: pode("editar_mensagem") && pode("trocar_destino") && pode("trocar_canais"),
    pausar: pode("pause") && pode("resume"),
    iniciar: pode("start"),
    encerrar: pode("complete"),
    resolverIncerto: pode("resolver_incerto"),
  };
}
