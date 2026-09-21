import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { permissoesDaCentral } from "@/lib/campaigns/permissoes";

import { PainelClient } from "./_components/PainelClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Disparos" };

export default async function DisparosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app/inbox");
  const pode = permissoesDaCentral(activeOrg.role);
  // A porta do menu já some abaixo de "manager"; quem chega pela URL volta ao Inbox, e a API recusa igual.
  if (!pode.ver) redirect("/app/inbox");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Central de Disparos</h1>
        <p className="text-sm text-muted-foreground">Campanhas de mensagem pelos seus números: acompanhe o envio, pause quando quiser e veja quem entrou no grupo.</p>
      </header>
      <PainelClient pode={pode} />
    </div>
  );
}
