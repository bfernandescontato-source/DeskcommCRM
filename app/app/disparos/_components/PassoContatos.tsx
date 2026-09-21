"use client";

import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErroDaCentral } from "@/hooks/campaigns/api";
import { chaves, descartarCsv, enviarCsv, importarLote, useCriarCampanha, useImportacao, urlDosRejeitados, validarCsv, type EstadoDaImportacao, type MapeamentoSugerido, type VisaoGeral } from "@/hooks/campaigns/useCampanhas";
import { MOTIVO_DE_REJEICAO, numero } from "@/lib/campaigns/formato";
import { DownloadSimple, UploadSimple } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { avisarErro, avisarOk, Barra, Girando, Secao, Selecao, useTexto, pf } from "./pecas";

const SEM_COLUNA = "-";

/** Passo 1a — só o nome. A campanha nasce como rascunho aqui e o resto do assistente passa a viver na URL do rascunho. */
export function PassoNome({ aoCriar }: { aoCriar: (id: string) => void }) {
  const { t } = useTexto();
  const criar = useCriarCampanha();
  const [nome, setNome] = React.useState("");
  return (
    <Secao titulo="Como se chama esta campanha?" descricao="Só para você reconhecer depois. A campanha fica salva como rascunho e você pode voltar a ela quando quiser.">
      <form
        className="flex max-w-md flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (nome.trim() === "") return;
          criar.mutate({ name: nome.trim() }, { onSuccess: (r) => aoCriar(r.id), onError: avisarErro });
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="nome">{t("Nome da campanha")}</Label>
          <Input id="nome" autoFocus value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t("Black Friday 2026")} maxLength={120} />
        </div>
        <Button type="submit" className="w-fit" disabled={criar.isPending || nome.trim() === ""}>
          {criar.isPending ? <Girando className="size-4" /> : null}
          {t("Criar e continuar")}
        </Button>
      </form>
    </Secao>
  );
}

/**
 * Passo 1b — o CSV. Cada etapa (enviar, mapear, validar, importar) é uma chamada curta; o estado mora
 * no servidor (`importacao`), então atualizar a página no meio retoma do mesmo ponto — a URL guarda só o id.
 */
export function PassoContatos({ v, importId, aoMudarImportacao }: { v: VisaoGeral; importId: string | null; aoMudarImportacao: (id: string | null) => void }) {
  const { t } = useTexto();
  const qc = useQueryClient();
  const id = v.campaign.id;
  const imp = useImportacao(id, importId);
  const [ocupado, setOcupado] = React.useState<null | "enviando" | "validando" | "importando">(null);
  const rodando = React.useRef(false);
  // Falhou no meio: não retoma sozinho em laço — a pessoa decide "continuar" depois de ler o erro.
  const [parou, setParou] = React.useState(false);

  const atualiza = () => Promise.all([qc.invalidateQueries({ queryKey: chaves.importacao(id, importId ?? "-") }), qc.invalidateQueries({ queryKey: chaves.campanha(id) })]);

  const subir = async (arquivo: File) => {
    setOcupado("enviando");
    try {
      const r = await enviarCsv(id, arquivo);
      aoMudarImportacao(r.import_id);
    } catch (e) {
      avisarErro(e);
    } finally {
      setOcupado(null);
    }
  };

  const importar = React.useCallback(
    async (idDoArquivo: string) => {
      if (rodando.current) return;
      rodando.current = true;
      setParou(false);
      setOcupado("importando");
      try {
        for (;;) {
          const r = await importarLote(id, idDoArquivo);
          await qc.invalidateQueries({ queryKey: chaves.importacao(id, idDoArquivo) });
          if (r.remaining === 0) break;
        }
        avisarOk(t("Contatos importados."));
      } catch (e) {
        avisarErro(e);
        setParou(true);
      } finally {
        rodando.current = false;
        setOcupado(null);
        void qc.invalidateQueries({ queryKey: chaves.campanha(id) });
      }
    },
    [id, qc],
  );

  // Recarregou no meio da importação: continua de onde parou (o banco sabe quantos faltam).
  React.useEffect(() => {
    if (importId && imp.data?.status === "importing" && ocupado === null && !parou) void importar(importId);
  }, [importId, imp.data?.status, ocupado, parou, importar]);

  const estado = imp.data;
  const emAndamento = importId !== null && estado !== undefined && estado.status !== "done" && estado.status !== "cancelled";

  return (
    <div className="flex flex-col gap-4">
      {v.counts.total > 0 ? (
        <p className="rounded-lg border border-border bg-success-bg px-3 py-2 text-sm text-success-fg">
          {pf(t("{n} contatos já estão nesta campanha."), { n: numero(v.counts.total) })}
          {emAndamento ? "" : ` ${t("Você pode importar outro arquivo — quem já está na campanha é ignorado.")}`}
        </p>
      ) : null}

      {imp.error && !(imp.error instanceof ErroDaCentral && imp.error.status === 404) ? <p className="text-sm text-error-fg">{imp.error.message}</p> : null}

      {!emAndamento ? (
        <Enviador ocupado={ocupado === "enviando"} aoEscolher={subir} concluida={estado?.status === "done" ? estado : null} />
      ) : estado.status === "uploaded" ? (
        <Mapeamento
          estado={estado}
          ocupado={ocupado === "validando"}
          aoDescartar={async () => {
            await descartarCsv(id, estado.import_id).catch(avisarErro);
            aoMudarImportacao(null);
          }}
          aoValidar={async (mapa) => {
            setOcupado("validando");
            try {
              await validarCsv(id, estado.import_id, mapa);
              await atualiza();
            } catch (e) {
              avisarErro(e);
            } finally {
              setOcupado(null);
            }
          }}
        />
      ) : (
        <Resumo
          estado={estado}
          campaignId={id}
          importando={ocupado === "importando"}
          aoDescartar={async () => {
            await descartarCsv(id, estado.import_id).catch(avisarErro);
            aoMudarImportacao(null);
            void qc.invalidateQueries({ queryKey: chaves.campanha(id) });
          }}
          aoImportar={() => void importar(estado.import_id)}
        />
      )}
    </div>
  );
}

function Enviador({ ocupado, aoEscolher, concluida }: { ocupado: boolean; aoEscolher: (f: File) => void; concluida: EstadoDaImportacao | null }) {
  const { t } = useTexto();
  const [arrastando, setArrastando] = React.useState(false);
  const entrada = React.useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setArrastando(true);
      }}
      onDragLeave={() => setArrastando(false)}
      onDrop={(e) => {
        e.preventDefault();
        setArrastando(false);
        const f = e.dataTransfer.files[0];
        if (f) aoEscolher(f);
      }}
      className={cn("flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors", arrastando ? "border-accent bg-accent-soft" : "border-border bg-surface")}
    >
      <UploadSimple weight="duotone" className="size-8 text-accent" aria-hidden />
      <div>
        <p className="text-sm font-medium">{concluida ? `Pronto: ${numero(concluida.imported)} contatos importados de ${concluida.filename}` : t("Arraste o arquivo CSV aqui")}</p>
        <p className="mt-1 text-xs text-text-muted">{t("Precisa ter uma coluna de telefone. Nome, e-mail e outras colunas (que viram variáveis da mensagem) são opcionais. Aceita arquivos grandes, com dezenas de milhares de linhas.")}</p>
      </div>
      <input ref={entrada} type="file" accept=".csv,text/csv" className="sr-only" aria-label={t("Arquivo CSV")} onChange={(e) => e.target.files?.[0] && aoEscolher(e.target.files[0])} />
      <Button variant="outline" disabled={ocupado} onClick={() => entrada.current?.click()}>
        {ocupado ? <Girando className="size-4" /> : null}
        {ocupado ? t("Enviando o arquivo…") : concluida ? t("Importar outro arquivo") : t("Escolher arquivo")}
      </Button>
    </div>
  );
}

function Mapeamento({ estado, ocupado, aoValidar, aoDescartar }: { estado: EstadoDaImportacao; ocupado: boolean; aoValidar: (m: { phone: number; name: number | null; email: number | null; extras: Array<{ key: string; index: number }> }) => void; aoDescartar: () => void }) {
  const { t } = useTexto();
  const sug: MapeamentoSugerido = estado.suggested_mapping ?? { phone: null, name: null, email: null, extras: [] };
  const [telefone, setTelefone] = React.useState<string>(sug.phone === null ? SEM_COLUNA : String(sug.phone));
  const [nome, setNome] = React.useState<string>(sug.name === null ? SEM_COLUNA : String(sug.name));
  const [email, setEmail] = React.useState<string>(sug.email === null ? SEM_COLUNA : String(sug.email));
  const [extras, setExtras] = React.useState<Set<number>>(() => new Set(sug.extras.map((e) => e.index)));
  const colunas = estado.headers.map((h, i) => ({ valor: String(i), rotulo: h || `Coluna ${i + 1}` }));
  const opcoes = [{ valor: SEM_COLUNA, rotulo: "— não usar —" }, ...colunas];
  const usadas = new Set([telefone, nome, email].filter((x) => x !== SEM_COLUNA).map(Number));
  const candidatas = sug.extras.filter((e) => !usadas.has(e.index));
  const alterna = (i: number) => setExtras((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])));

  return (
    <Secao titulo={`Confira as colunas de ${estado.filename}`} descricao={`${numero(estado.total_rows)} linhas encontradas. Diga qual coluna é o telefone e o que mais você quer usar.`}>
      <div className="flex flex-col gap-4">
        {(estado.sample ?? []).length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-elevated text-left text-text-muted">
                <tr>
                  {estado.headers.map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-3 py-1.5 font-medium">
                      {h || `Coluna ${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(estado.sample ?? []).map((l, r) => (
                  <tr key={r} className="border-t border-border/60">
                    {estado.headers.map((_, i) => (
                      <td key={i} className="whitespace-nowrap px-3 py-1.5">
                        {l[i] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>{t("Telefone (obrigatório)")}</Label>
            <Selecao rotulo="Coluna do telefone" className="w-full" valor={telefone} aoMudar={setTelefone} opcoes={opcoes} />
          </div>
          <div className="space-y-1">
            <Label>{t("Nome")}</Label>
            <Selecao rotulo="Coluna do nome" className="w-full" valor={nome} aoMudar={setNome} opcoes={opcoes} />
          </div>
          <div className="space-y-1">
            <Label>{t("E-mail")}</Label>
            <Selecao rotulo="Coluna do e-mail" className="w-full" valor={email} aoMudar={setEmail} opcoes={opcoes} />
          </div>
        </div>

        {candidatas.length > 0 ? (
          <div className="space-y-1.5">
            <Label>{t("Usar como variável na mensagem")}</Label>
            <div className="flex flex-wrap gap-2">
              {candidatas.map((c) => (
                <label key={c.index} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-accent-soft/40">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={extras.has(c.index)} onChange={() => alterna(c.index)} />
                  <span>{c.label}</span>
                  <code className="text-xs text-text-muted">{`{{${c.key}}}`}</code>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={ocupado || telefone === SEM_COLUNA}
            onClick={() =>
              aoValidar({
                phone: Number(telefone),
                name: nome === SEM_COLUNA ? null : Number(nome),
                email: email === SEM_COLUNA ? null : Number(email),
                extras: candidatas.filter((c) => extras.has(c.index)).map((c) => ({ key: c.key, index: c.index })),
              })
            }
          >
            {ocupado ? <Girando className="size-4" /> : null}
            {ocupado ? t("Conferindo as linhas…") : t("Conferir arquivo")}
          </Button>
          <Button variant="ghost" disabled={ocupado} onClick={aoDescartar}>
            {t("Descartar arquivo")}
          </Button>
        </div>
      </div>
    </Secao>
  );
}

function Resumo({ estado, campaignId, importando, aoImportar, aoDescartar }: { estado: EstadoDaImportacao; campaignId: string; importando: boolean; aoImportar: () => void; aoDescartar: () => void }) {
  const { t } = useTexto();
  // `valid` = ainda por importar; `imported` = já entrou. O total a importar é a soma.
  const total = estado.valid + estado.imported;
  const recusados = Object.entries(estado.by_reason).filter(([, n]) => (n ?? 0) > 0);
  return (
    <Secao titulo={`Resultado da conferência de ${estado.filename}`} descricao="Nada foi importado ainda. Confira os números e confirme.">
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Numero rotulo="Válidos" valor={numero(total)} tom="ok" />
          <Numero rotulo="Contatos novos" valor={numero(estado.new_contacts)} />
          <Numero rotulo="Já existiam no CRM" valor={numero(estado.existing_contacts)} />
          <Numero rotulo="Recusados" valor={numero(estado.rejected)} tom={estado.rejected > 0 ? "aviso" : undefined} />
        </dl>

        {recusados.length > 0 ? (
          <div className="rounded-lg border border-border p-3">
            <p className="mb-1 text-xs font-semibold text-text-muted">{t("Por que foram recusados")}</p>
            <ul className="space-y-0.5 text-sm">
              {recusados.map(([motivo, n]) => (
                <li key={motivo} className="flex justify-between gap-3">
                  <span>{MOTIVO_DE_REJEICAO[motivo] ?? motivo}</span>
                  <span className="tabular-nums">{numero(n ?? 0)}</span>
                </li>
              ))}
            </ul>
            <Button asChild size="sm" variant="outline" className="mt-2">
              <a href={urlDosRejeitados(campaignId, estado.import_id)} download>
                <DownloadSimple weight="duotone" /> {t("Baixar os recusados (CSV)")}
              </a>
            </Button>
          </div>
        ) : null}

        {importando || estado.status === "importing" ? (
          <div className="space-y-1.5" aria-live="polite">
            <Barra valor={estado.imported} total={total} />
            <p className="text-xs text-text-muted">
              {pf(t("Importando: {feitos} de {total}. Pode atualizar a página — a importação continua de onde parou."), { feitos: numero(estado.imported), total: numero(total) })}
            </p>
            {!importando ? (
              <Button size="sm" onClick={aoImportar}>
                {t("Continuar importação")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button disabled={total === 0} onClick={aoImportar}>
              {pf(t("Importar {n} contatos"), { n: numero(total) })}
            </Button>
            <Button variant="ghost" onClick={aoDescartar}>
              {t("Descartar arquivo")}
            </Button>
          </div>
        )}
      </div>
    </Secao>
  );
}

function Numero({ rotulo, valor, tom }: { rotulo: string; valor: string; tom?: "ok" | "aviso" }) {
  const { t } = useTexto();
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <dt className="text-xs text-text-muted">{t(rotulo)}</dt>
      <dd className={cn("mt-0.5 text-xl font-semibold tabular-nums", tom === "ok" && "text-success-fg", tom === "aviso" && "text-warning-fg")}>{valor}</dd>
    </div>
  );
}
