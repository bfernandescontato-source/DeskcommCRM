/**
 * O cliente HTTP da Central de Disparos — só `fetch` e o formato do envelope `{ data, meta }`.
 *
 * Fica separado dos hooks para que a regra "erro do servidor vira mensagem que a pessoa lê,
 * com o código estável para a tela reagir" seja uma função pura, testável sem React.
 */
export const BASE = "/api/v1/campaigns";

export class ErroDaCentral extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ErroDaCentral";
  }
}

export interface Resposta<T> {
  data: T;
  meta?: { cursor?: string | null; has_more?: boolean };
}

/** Uma chamada à API. Erro do servidor (envelope `{ error }`) vira `ErroDaCentral`; rede caída também. */
export async function chamar<T>(caminho: string, init: RequestInit & { json?: unknown } = {}): Promise<Resposta<T>> {
  const { json, headers, ...resto } = init;
  let res: Response;
  try {
    res = await fetch(`${BASE}${caminho}`, {
      ...resto,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch {
    throw new ErroDaCentral("Sem conexão com o servidor. Verifique a internet e tente de novo.", "network", 0);
  }
  const corpo = (await res.json().catch(() => null)) as
    | (Resposta<T> & { error?: { code?: string; message?: string; details?: Record<string, unknown> } })
    | null;
  if (!res.ok || !corpo || corpo.error) {
    throw new ErroDaCentral(
      corpo?.error?.message ?? "Não foi possível concluir. Tente de novo.",
      corpo?.error?.code ?? "unknown",
      res.status,
      corpo?.error?.details,
    );
  }
  return corpo;
}

/** A query string da Fila: só o que tem valor, na ordem estável (a chave do cache depende disso). */
export function queryDaFila(f: {
  status?: string[];
  channel?: string;
  destination?: string;
  version?: string;
  clicked?: boolean;
  replied?: boolean;
  q?: string;
  from?: string;
  to?: string;
  after?: number;
  limit?: number;
}): string {
  const p = new URLSearchParams();
  if (f.status?.length) p.set("status", f.status.join(","));
  if (f.channel) p.set("channel", f.channel);
  if (f.destination) p.set("destination", f.destination);
  if (f.version) p.set("version", f.version);
  if (f.clicked) p.set("clicked", "true");
  if (f.replied) p.set("replied", "true");
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.after) p.set("after", String(f.after));
  if (f.limit) p.set("limit", String(f.limit));
  return p.toString();
}
