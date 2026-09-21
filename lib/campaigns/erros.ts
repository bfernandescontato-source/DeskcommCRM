/**
 * Erros do banco da Central de Disparos -> erro de API que a tela entende.
 *
 * As funções `fn_campaign_*` levantam códigos estáveis em `message`
 * (`campaign_version_conflict`, `campaign_no_channel`…). O PostgREST devolve
 * `{ message, code, details }`; aqui o código vira status HTTP + frase em
 * português + o que a tela precisa para reagir (ex.: qual versão é a atual).
 */

export interface ErroDeCampanha {
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

interface ErroDoPostgrest {
  message?: string | null;
  code?: string | null;
  details?: string | null;
}

/** O que falta para iniciar, na ordem do assistente (contatos, mensagem, destino, canais). */
export const FALTA_PARA_INICIAR = {
  campaign_no_contacts: "contacts",
  campaign_no_message: "message",
  campaign_no_destination: "destination",
  campaign_no_channel: "channel",
} as const;

const TABELA: Record<string, Omit<ErroDeCampanha, "details">> = {
  campaign_not_found: { code: "campaign_not_found", status: 404, message: "Campanha não encontrada." },
  campaign_org_not_found: { code: "campaign_not_found", status: 404, message: "Campanha não encontrada." },
  campaign_destination_not_found: { code: "destination_not_found", status: 404, message: "Destino não encontrado nesta campanha." },
  campaign_closed: { code: "campaign_closed", status: 409, message: "Esta campanha já foi encerrada e não aceita mudanças." },
  campaign_invalid_transition: { code: "invalid_transition", status: 409, message: "Esta ação não é possível no estado atual da campanha." },
  campaign_invalid_action: { code: "validation_failed", status: 422, message: "Ação desconhecida." },
  campaign_no_contacts: { code: "campaign_incomplete", status: 422, message: "Importe os contatos antes de iniciar." },
  campaign_no_message: { code: "campaign_incomplete", status: 422, message: "Escreva a mensagem antes de iniciar." },
  campaign_no_destination: { code: "campaign_incomplete", status: 422, message: "A mensagem usa {{link_grupo}}: escolha o grupo de destino antes de iniciar." },
  campaign_no_channel: { code: "campaign_incomplete", status: 422, message: "Escolha ao menos um número para enviar." },
  campaign_invalid_channel: { code: "invalid_channel", status: 422, message: "Um dos números escolhidos não existe, está arquivado ou não é de WhatsApp." },
  campaign_version_conflict: { code: "version_conflict", status: 409, message: "A mensagem foi alterada por outra pessoa enquanto você editava. Recarregue para ver a versão atual." },
  campaign_destination_conflict: { code: "destination_conflict", status: 409, message: "O destino foi trocado por outra pessoa. Recarregue para ver o destino atual." },
  campaign_destination_closed: { code: "destination_closed", status: 409, message: "Este destino já foi encerrado. Cadastre um novo grupo." },
  campaign_import_not_found: { code: "import_not_found", status: 404, message: "Importação não encontrada." },
  campaign_import_locked: { code: "import_locked", status: 409, message: "Esta importação não aceita mais mudanças." },
  campaign_import_not_validated: { code: "import_not_validated", status: 409, message: "Valide o arquivo antes de importar." },
  campaign_version_immutable: { code: "version_immutable", status: 409, message: "Versões de mensagem não podem ser editadas; crie uma nova versão." },
};

export function erroDaCampanha(err: ErroDoPostgrest): ErroDeCampanha {
  const chave = (err.message ?? "").split("\n")[0]?.trim() ?? "";
  const conhecido = TABELA[chave];
  if (conhecido) {
    const details: Record<string, unknown> = {};
    if (chave in FALTA_PARA_INICIAR) details.missing = FALTA_PARA_INICIAR[chave as keyof typeof FALTA_PARA_INICIAR];
    const atual = /current=(\d+)/.exec(err.details ?? "");
    if (chave === "campaign_version_conflict" && atual) details.current_version_no = Number(atual[1]);
    const par = /^(\w+) -> (\w+)$/.exec(err.details ?? "");
    if (chave === "campaign_invalid_transition" && par) {
      details.from = par[1];
      details.to = par[2];
    }
    return { ...conhecido, ...(Object.keys(details).length ? { details } : {}) };
  }
  // 23514 = check_violation (nome vazio, link fora do padrão…); 23505 = unique.
  if (err.code === "23514") {
    return { code: "validation_failed", status: 422, message: "Algum dado está fora do formato permitido." };
  }
  if (err.code === "23505") {
    return { code: "conflict", status: 409, message: "Este registro já existe." };
  }
  return { code: "internal_error", status: 500, message: "Erro ao processar a campanha." };
}
