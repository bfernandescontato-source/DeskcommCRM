"use client";

import * as React from "react";

import { Textarea } from "@/components/ui/textarea";
import type { VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { previaDaMensagem } from "@/lib/campaigns/mensagem";

import { useTexto, pf } from "./pecas";

export const LIMITE_DA_MENSAGEM = 4096;

/**
 * O estado do editor: o texto, a prévia e o que impede salvar. Compartilhado pela aba Mensagens
 * (nova versão com a campanha rodando) e pelo assistente (primeira versão).
 */
export function useEditorDeMensagem(v: VisaoGeral) {
  const ativa = v.versions.find((x) => x.id === v.campaign.active_version_id) ?? null;
  const [texto, setTexto] = React.useState(ativa?.body ?? "");
  const campo = React.useRef<HTMLTextAreaElement>(null);
  const cursorPendente = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    if (cursorPendente.current === null || !campo.current) return;
    campo.current.setSelectionRange(cursorPendente.current, cursorPendente.current);
    cursorPendente.current = null;
  }, [texto]);

  const destino = v.destinations.find((d) => d.id === v.campaign.active_destination_id) ?? v.destinations.find((d) => d.status === "queued") ?? null;
  const link = v.campaign.tracking_enabled ? `${typeof window === "undefined" ? "" : window.location.origin}/g/‹código›` : (destino?.invite_url ?? null);
  const previa = previaDaMensagem(texto, { linkGrupo: destino ? link : null });
  const trecho = texto.trim();
  const problema =
    trecho === "" ? "Escreva a mensagem." : texto.length > LIMITE_DA_MENSAGEM ? `Passou de ${LIMITE_DA_MENSAGEM} caracteres.` : previa.chavesSoltas ? "Há uma variável mal formada. Use o formato {{nome}}." : null;
  const mudou = trecho !== (ativa?.body ?? "").trim();

  const inserir = (variavel: string) => {
    const el = campo.current;
    const marca = `{{${variavel}}}`;
    if (!el) return setTexto((t) => t + marca);
    const ini = el.selectionStart ?? texto.length;
    const fim = el.selectionEnd ?? texto.length;
    // O foco volta ao campo NA HORA (a próxima tecla não pode cair no botão da variável) e o cursor é
    // posicionado logo depois que o React grava o texto (layout effect), antes de qualquer nova tecla.
    el.focus();
    cursorPendente.current = ini + marca.length;
    setTexto(texto.slice(0, ini) + marca + texto.slice(fim));
  };

  return { ativa, texto, setTexto, campo, previa, trecho, problema, mudou, inserir };
}

export type Editor = ReturnType<typeof useEditorDeMensagem>;

/** O campo em si: variáveis clicáveis, texto, contagem e a prévia de como a pessoa vai ver. */
export function CampoDaMensagem({ e }: { e: Editor }) {
  const { t } = useTexto();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" aria-label={t("Variáveis")}>
        {["nome", "primeiro_nome", "link_grupo"].map((k) => (
          <button key={k} type="button" onClick={() => e.inserir(k)} className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-text-muted hover:border-accent hover:text-accent">
            {`{{${k}}}`}
          </button>
        ))}
        <span className="self-center text-xs text-text-muted">{t("e as colunas do seu CSV, como {{cidade}}")}</span>
      </div>
      <Textarea ref={e.campo} rows={7} value={e.texto} onChange={(ev) => e.setTexto(ev.target.value)} aria-label={t("Texto da mensagem")} aria-invalid={e.problema !== null && e.trecho !== ""} />
      <div className="flex justify-between text-xs text-text-muted">
        <span className={e.problema ? "text-error-fg" : undefined}>{e.problema ? t(e.problema) : " "}</span>
        <span className="tabular-nums">
          {e.texto.length}/{LIMITE_DA_MENSAGEM}
        </span>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-text-muted">{t("Como a pessoa vai ver")}</p>
        <p className="whitespace-pre-wrap rounded-lg border border-border bg-surface-elevated p-3 text-sm">{e.trecho === "" ? "—" : e.previa.texto}</p>
        {e.previa.faltaDestino ? <p className="mt-1 text-xs text-warning-fg">{t("A mensagem usa {{link_grupo}}: cadastre um grupo em Destinos antes de iniciar.")}</p> : null}
        {e.previa.doCsv.length > 0 ? <p className="mt-1 text-xs text-text-muted">{pf(t("Vem do CSV: {colunas}. Contato sem esse dado não recebe (fica como falha, visível na Fila)."), { colunas: e.previa.doCsv.join(", ") })}</p> : null}
      </div>
    </div>
  );
}
